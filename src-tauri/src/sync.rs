//! 多设备同步的调度和给网页的命令。同步本身在 beayy-sync（方案见 报告/方案_20261016_多设备同步.md）。
//! 每 5 分钟一轮；测试版（--shadow）不同步，免得把影子目录传上去。

use beayy_core::{data_root, fields, local_device, shadow_mode, EventLog};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const EVERY: Duration = Duration::from_secs(300);

static RUNNING: AtomicBool = AtomicBool::new(false);
static NOW: OnceLock<Mutex<bool>> = OnceLock::new();

/// 跑一轮（同一时间只跑一轮），记一条 sync.run
fn run(log: Option<&EventLog>) -> Option<beayy_sync::Report> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return None;
    }
    let t = std::time::Instant::now();
    // 手机版只下载：它不采集电脑那种分段，自己算出的东西也不能当成某台设备的分段传上去
    #[cfg(target_os = "ios")]
    let r = beayy_sync::sync_download_only(&data_root(), &local_device());
    #[cfg(not(target_os = "ios"))]
    let r = beayy_sync::sync_once(&data_root(), &local_device());
    RUNNING.store(false, Ordering::SeqCst);
    if let (Some(r), Some(log)) = (&r, log) {
        if r.uploaded + r.downloaded > 0 || !r.errors.is_empty() {
            log.write(
                "sync.run",
                fields! {"uploaded" => r.uploaded, "downloaded" => r.downloaded, "errors" => r.errors.len(), "seconds" => t.elapsed().as_secs()},
                None,
            );
        }
    }
    r
}

pub fn start(log: Arc<EventLog>) {
    if shadow_mode() {
        return;
    }
    std::thread::spawn(move || loop {
        run(Some(&log));
        pull_profile();
        // 模型配置跟着账号走：本机改过就推、别的设备改过就拉（密钥不在这块里）
        let _ = beayy_remote::cloud::sync_model_profile(&data_root());
        // 等 5 分钟，期间页面点了「立即同步」就提前跑
        let mut waited = Duration::ZERO;
        while waited < EVERY {
            std::thread::sleep(Duration::from_secs(1));
            waited += Duration::from_secs(1);
            let flag = NOW.get_or_init(|| Mutex::new(false));
            if std::mem::take(&mut *flag.lock().unwrap()) {
                break;
            }
        }
    });
}

/// 账号上的头像和名称比本机新（在别的设备上改过），就拉下来
fn pull_profile() {
    let root = data_root();
    if beayy_sync::load(&root).and_then(|a| a.email).is_none() {
        return;
    }
    if let Ok(v) = beayy_sync::account(&root) {
        let p = &v["profile"];
        let updated = p["updated"].as_i64().unwrap_or(0);
        if updated > crate::data::profile_updated() {
            let _ = crate::data::write_profile(p["name"].as_str().unwrap_or(""), p["avatar"].as_str(), updated);
        }
    }
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub fn sync_status() -> Value {
    let mut v = beayy_sync::status(&data_root());
    v["running"] = json!(RUNNING.load(Ordering::SeqCst));
    v["shadow"] = json!(shadow_mode());
    v
}



/// 立即同步一轮，返回结果
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn sync_now() -> Result<Value, String> {
    match run(None) {
        Some(r) => Ok(json!({"uploaded": r.uploaded, "downloaded": r.downloaded, "errors": r.errors})),
        None => Err("没开同步，或者正在同步".into()),
    }
}



// ---------- 账号（邮箱＋主密码） ----------

/// 这台设备在账号里显示的名字
fn device_name() -> String {
    let d = local_device();
    match d.split_once('-') {
        Some(("mac", h)) => format!("Mac · {h}"),
        Some(("win", h)) => format!("Windows · {h}"),
        Some(("iosapp", _)) => "iPhone（Beayy）".into(),
        _ => d,
    }
}

fn kick() {
    *NOW.get_or_init(|| Mutex::new(false)).lock().unwrap() = true;
}

/// 注册、登录用的同步服务器：设置里的 sync_server（自建的），没填用官方的
pub fn server() -> String {
    crate::data::read_settings_raw().get("sync_server").and_then(|v| v.as_str()).map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| beayy_sync::DEFAULT_SERVER.to_string())
}

/// 注册新账号，返回恢复码
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_signup(invite: String, email: String, password: String) -> Result<String, String> {
    let code = beayy_sync::signup(&data_root(), &server(), invite.trim(), &email, &password, &local_device(), &device_name())?;
    kick();
    Ok(code)
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_login(email: String, password: String) -> Result<(), String> {
    beayy_sync::login(&data_root(), &server(), &email, &password, &local_device(), &device_name())?;
    kick();
    Ok(())
}

/// 老账号（配对码时期）设邮箱和主密码，返回恢复码
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_claim(email: String, password: String) -> Result<String, String> {
    beayy_sync::claim(&data_root(), &email, &password, &local_device(), &device_name())
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_recover(email: String, code: String, password: String) -> Result<(), String> {
    beayy_sync::recover(&data_root(), &server(), &email, &code, &password, &local_device(), &device_name())?;
    kick();
    Ok(())
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_password(password: String) -> Result<(), String> {
    beayy_sync::change_password(&data_root(), &password)
}

/// 账号信息：邮箱、登录着的设备（标出哪台是这台）
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_info() -> Result<Value, String> {
    beayy_sync::account(&data_root())
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_remove_device(id: String) -> Result<(), String> {
    beayy_sync::remove_session(&data_root(), &id)
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn account_logout() {
    beayy_sync::logout(&data_root());
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub fn account_recovery_code() -> Option<String> {
    beayy_sync::recovery_code(&data_root())
}

/// 命令行：beayy --account-signup <邀请码> <邮箱> <主密码>｜--account-login <邮箱> <主密码>｜--account-claim｜--account-recover｜--account-password｜--account-info｜--account-remove <id>｜--account-logout｜--sync-once｜--sync-status。返回退出码
pub fn cli(args: &[String]) -> Option<i32> {
    let root = data_root();
    let out = match args.get(1).map(String::as_str) {
        Some("--account-signup") => beayy_sync::signup(&root, &server(), args.get(2)?, args.get(3)?, args.get(4)?, &local_device(), &device_name()).map(|c| format!("已注册，恢复码 {c}")),
        Some("--account-login") => beayy_sync::login(&root, &server(), args.get(2)?, args.get(3)?, &local_device(), &device_name()).map(|_| "已登录".into()),
        Some("--account-claim") => beayy_sync::claim(&root, args.get(2)?, args.get(3)?, &local_device(), &device_name()).map(|c| format!("已设好邮箱和主密码，恢复码 {c}")),
        Some("--account-recover") => beayy_sync::recover(&root, &server(), args.get(2)?, args.get(3)?, args.get(4)?, &local_device(), &device_name()).map(|_| "已用恢复码重设并登录".into()),
        Some("--account-password") => beayy_sync::change_password(&root, args.get(2)?).map(|_| "已改主密码".into()),
        Some("--account-info") => beayy_sync::account(&root).map(|v| serde_json::to_string_pretty(&v).unwrap()),
        Some("--account-remove") => beayy_sync::remove_session(&root, args.get(2)?).map(|_| "已移除".into()),
        Some("--account-logout") => {
            beayy_sync::logout(&root);
            Ok("已退出".into())
        }
        Some("--sync-status") => Ok(serde_json::to_string_pretty(&beayy_sync::status(&root)).unwrap()),
        Some("--sync-once") => {
            let t = std::time::Instant::now();
            match beayy_sync::sync_once(&root, &local_device()) {
                Some(r) => Ok(format!("上传 {}，下载 {}，{:.1} 秒{}", r.uploaded, r.downloaded, t.elapsed().as_secs_f64(), if r.errors.is_empty() { String::new() } else { format!("；出错：{}", r.errors.join("；")) })),
                None => Err("没开同步".into()),
            }
        }
        _ => return None,
    };
    match out {
        Ok(s) => {
            println!("{s}");
            Some(0)
        }
        Err(e) => {
            eprintln!("{e}");
            Some(1)
        }
    }
}
