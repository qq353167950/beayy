//! Beayy 各平台共用的核心：数据目录、设备名、事件写入。
//!
//! 事件格式（见 app/README.md）和最早的 Swift 版逐字节一致，旧数据不用迁移：
//! `<数据根>/devices/<设备>/segments/<UTC 整 10 分>/events.jsonl`，每行一个 JSON，键按字母排序，
//! 每条带 `event_type`、`timestamp`（UTC，ISO8601 毫秒，带 Z）、`device`。只追加，不改写。

pub mod model_config;

use chrono::{DateTime, Timelike, Utc};
use serde_json::{Map, Value};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 数据根目录。默认 `~/Library/Application Support/Beayy`（Windows 为 `%APPDATA%\Beayy`）。
/// 环境变量 `BEAYY_DATA_ROOT` 可整个改掉；`BEAYY_SHADOW=1` 时写到根下的 `shadow/`（并跑期间不和正式数据混）。
pub fn data_root() -> PathBuf {
    let base = if let Ok(p) = std::env::var("BEAYY_DATA_ROOT") {
        PathBuf::from(p)
    } else {
        default_root()
    };
    if shadow_mode() {
        base.join("shadow")
    } else {
        base
    }
}

/// 摘要用的默认网关和模型。编译时可用环境变量 BEAYY_DEFAULT_GATEWAY、BEAYY_DEFAULT_MODEL 换掉
/// （自己打包时给用户预填一组能用的，密钥仍要用户自己填）；没给就是 OpenAI 官方地址、模型留空
pub const DEFAULT_GATEWAY: &str = match option_env!("BEAYY_DEFAULT_GATEWAY") {
    Some(s) => s,
    None => "https://api.openai.com/v1",
};
pub const DEFAULT_MODEL: &str = match option_env!("BEAYY_DEFAULT_MODEL") {
    Some(s) => s,
    None => "",
};

/// 默认的转写服务（官方的；自己搭的在设置里换）。编译时可用 BEAYY_DEFAULT_TRANSCRIBE 换掉
pub const DEFAULT_TRANSCRIBE: &str = match option_env!("BEAYY_DEFAULT_TRANSCRIBE") {
    Some(s) => s,
    None => "https://audio.beayy.com",
};

/// 正式数据根（不管影子模式），读 iPhone 对数、读摘要时用
pub fn default_root() -> PathBuf {
    // Android：没有 HOME，也没有 Library 概念。应用私有目录由外壳（JNI）在启动时
    // 写进 BEAYY_ANDROID_HOME（MainActivity 里 app.filesDir），这里只做兜底。
    #[cfg(target_os = "android")]
    {
        if let Ok(home) = std::env::var("BEAYY_ANDROID_HOME") {
            return PathBuf::from(home);
        }
        PathBuf::from("/data/local/tmp/beayy")
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(target_os = "windows")]
        {
            let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
            PathBuf::from(appdata).join("Beayy")
        }
        #[cfg(not(target_os = "windows"))]
        {
            let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
            PathBuf::from(home).join("Library/Application Support/Beayy")
        }
    }
}

pub fn shadow_mode() -> bool {
    std::env::var("BEAYY_SHADOW").map(|v| v == "1").unwrap_or(false)
}

/// 存在系统钥匙串里的一项（服务 com.fengli.beayy，账号 `account`）；没有钥匙串的系统（Windows）存在数据目录 secrets/<账号>，未加密
pub fn secret_get(account: &str) -> Option<String> {
    #[cfg(target_os = "macos")]
    let v = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "com.fengli.beayy", "-a", account, "-w"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    #[cfg(not(target_os = "macos"))]
    let v = fs::read_to_string(default_root().join("secrets").join(account)).ok().map(|s| s.trim().to_string());
    v.filter(|s| !s.is_empty())
}

/// 存一项；`value` 为空＝删掉
pub fn secret_set(account: &str, value: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let args: Vec<&str> = if value.is_empty() {
            vec!["delete-generic-password", "-s", "com.fengli.beayy", "-a", account]
        } else {
            vec!["add-generic-password", "-U", "-s", "com.fengli.beayy", "-a", account, "-w", value]
        };
        let ok = std::process::Command::new("/usr/bin/security").args(args).output().map(|o| o.status.success()).unwrap_or(false);
        if ok || value.is_empty() { Ok(()) } else { Err("写入钥匙串失败".into()) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let f = default_root().join("secrets").join(account);
        if value.is_empty() {
            let _ = fs::remove_file(&f);
            return Ok(());
        }
        fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::write(&f, value).map_err(|e| e.to_string())
    }
}

/// 本机设备名：mac-<本地主机名>／win-<计算机名>。环境变量 BEAYY_DEVICE 可以改（测多设备同步时在同一台电脑上模拟第二台）
pub fn local_device() -> String {
    if let Ok(d) = std::env::var("BEAYY_DEVICE") {
        if !d.is_empty() {
            return d;
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/scutil").args(["--get", "LocalHostName"]).output();
        let name = out.ok().and_then(|o| String::from_utf8(o.stdout).ok()).map(|s| s.trim().to_string());
        format!("mac-{}", name.filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into()))
    }
    #[cfg(target_os = "windows")]
    {
        format!("win-{}", std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".into()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "other-unknown".into()
    }
}
// ---------- 设备家族 ----------

/// 手机（iPhone／Android）的设备目录名前缀。手机记录的数据（屏幕使用 app.focus、停留点 place.visit、
/// 对话转写 speech.*）都写在 `devices/<前缀>-<id>/` 下，和电脑（mac-、win-）分开算。
pub const PHONE_PREFIXES: [&str; 2] = ["iphone-", "android-"];
/// 手表的设备目录名前缀（录音转写写在 `devices/watch-<id>/`）
pub const WATCH_PREFIX: &str = "watch-";

/// 是不是手机（iPhone 或 Android）。数据来自手机、不算电脑，展示时并入「手机」那一栏。
///
/// 以前各处写死 `starts_with("iphone-")`，加 Android 时会漏掉一部分（同步不传、展示不认），
/// 所以判据只留这一份，其它地方一律调它。
pub fn is_phone(device: &str) -> bool {
    PHONE_PREFIXES.iter().any(|p| device.starts_with(p))
}

/// 是不是手表
pub fn is_watch(device: &str) -> bool {
    device.starts_with(WATCH_PREFIX)
}

/// 是不是电脑（mac-<主机名>、win-<计算机名>）。手机、手表都不算。
pub fn is_computer(device: &str) -> bool {
    !is_phone(device) && !is_watch(device)
}

/// 设备归类，给存储统计这类「按种类合计」的地方用：computer／phone／watch
pub fn device_kind(device: &str) -> &'static str {
    if is_watch(device) {
        "watch"
    } else if is_phone(device) {
        "phone"
    } else {
        "computer"
    }
}


/// UTC ISO8601，毫秒，带 Z。毫秒四舍五入（和 Swift 版 ISO8601DateFormatter 一致；直接格式化是截断）
pub fn iso(t: DateTime<Utc>) -> String {
    (t + chrono::Duration::microseconds(500)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// 事件所在的分段名：UTC 向下取整到 10 分钟
pub fn segment_key(t: DateTime<Utc>) -> String {
    let m = t.minute() / 10 * 10;
    format!("{}-{:02}-00Z", t.format("%Y-%m-%dT%H"), m)
}

struct Open {
    key: String,
    file: File,
}

/// 一台设备的事件日志
pub struct EventLog {
    pub device: String,
    pub root: PathBuf,
    open: Mutex<Option<Open>>,
    count: AtomicU64,
}

impl EventLog {
    pub fn new(root: PathBuf, device: impl Into<String>) -> Self {
        EventLog { device: device.into(), root, open: Mutex::new(None), count: AtomicU64::new(0) }
    }

    pub fn segments_dir(&self) -> PathBuf {
        self.root.join("devices").join(&self.device).join("segments")
    }

    pub fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    /// 写一条事件。`at` 为空＝现在；补录别处的历史记录（iPhone）时传事件发生的时刻。
    pub fn write(&self, event_type: &str, mut fields: Map<String, Value>, at: Option<DateTime<Utc>>) {
        let t = at.unwrap_or_else(Utc::now);
        fields.insert("event_type".into(), Value::String(event_type.into()));
        fields.insert("timestamp".into(), Value::String(iso(t)));
        fields.insert("device".into(), Value::String(self.device.clone()));
        // serde_json 默认的 Map 是按键排序的 BTreeMap，和 Swift 的 sortedKeys 一致
        let mut line = serde_json::to_vec(&Value::Object(fields)).unwrap_or_default();
        line.push(b'\n');
        let key = segment_key(t);
        let mut guard = self.open.lock().unwrap();
        if guard.as_ref().map(|o| o.key != key).unwrap_or(true) {
            let dir = self.segments_dir().join(&key);
            let _ = fs::create_dir_all(&dir);
            match OpenOptions::new().create(true).append(true).open(dir.join("events.jsonl")) {
                Ok(file) => *guard = Some(Open { key, file }),
                Err(_) => return,
            }
        }
        if let Some(o) = guard.as_mut() {
            // 一次写完整行，进程被杀时尽量不留半行
            if o.file.write_all(&line).is_ok() {
                self.count.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

/// 方便拼字段：`fields!{"app_name" => name, "pid" => 12}`
#[macro_export]
macro_rules! fields {
    ($($k:expr => $v:expr),* $(,)?) => {{
        let mut m = serde_json::Map::new();
        $( m.insert($k.to_string(), serde_json::json!($v)); )*
        m
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;


    #[test]
    fn device_family() {
        // 手机：iPhone 和 Android 都算，都并入「手机」那一栏
        assert!(is_phone("iphone-1a2b3c4d"));
        assert!(is_phone("android-5e6f7a8b"));
        assert!(!is_phone("mac-mymac"));
        assert!(!is_phone("win-pc"));
        assert!(!is_phone("watch-1a2b3c4d"));

        assert!(is_watch("watch-1a2b3c4d"));
        assert!(!is_watch("android-5e6f7a8b"));

        // 电脑：只有 mac-、win- 这类，手机手表都不算（「今天」里手机单独统计）
        assert!(is_computer("mac-mymac"));
        assert!(is_computer("win-pc"));
        assert!(!is_computer("iphone-1a2b3c4d"));
        assert!(!is_computer("android-5e6f7a8b"));
        assert!(!is_computer("watch-1a2b3c4d"));

        assert_eq!(device_kind("android-5e6f7a8b"), "phone");
        assert_eq!(device_kind("iphone-1a2b3c4d"), "phone");
        assert_eq!(device_kind("watch-1a2b3c4d"), "watch");
        assert_eq!(device_kind("mac-mymac"), "computer");
        assert_eq!(device_kind("win-pc"), "computer");
    }

    #[test]
    fn segment_and_iso() {
        let t = Utc.with_ymd_and_hms(2026, 10, 15, 12, 57, 3).unwrap();
        assert_eq!(segment_key(t), "2026-10-15T12-50-00Z");
        assert_eq!(iso(t), "2026-10-15T12:57:03.000Z");
    }

    #[test]
    fn write_appends_sorted_line() {
        let dir = std::env::temp_dir().join(format!("beayy-test-{}", std::process::id()));
        let log = EventLog::new(dir.clone(), "mac-test");
        let t = Utc.with_ymd_and_hms(2026, 10, 15, 12, 57, 3).unwrap();
        log.write("presence", fields! {"state" => "active", "idle_seconds" => 0}, Some(t));
        let text = fs::read_to_string(log.segments_dir().join("2026-10-15T12-50-00Z/events.jsonl")).unwrap();
        assert_eq!(
            text,
            "{\"device\":\"mac-test\",\"event_type\":\"presence\",\"idle_seconds\":0,\"state\":\"active\",\"timestamp\":\"2026-10-15T12:57:03.000Z\"}\n"
        );
        let _ = fs::remove_dir_all(dir);
    }
}
