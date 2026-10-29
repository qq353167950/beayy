//! Android 采集：无障碍服务（AccessibilityService）供数，这里做判断与落盘。
//!
//! 和桌面的分工一样：**读**在平台侧（Kotlin 的 `BeayyAccessibilityService` 读窗口树、通知、电量和媒体），
//! **怎么记**全在这里，并且复用 `common`（防抖、发送判定、操作者统计、黑名单、界面文字去重），
//! 所以 Android 记出来的事件和 macOS／Windows 是同一套字段，摘要引擎不用改就能吃。
//!
//! ## 和桌面能力的对应关系
//!
//! | 桌面事件 | Android 来源 | 说明 |
//! |---|---|---|
//! | `app.activated` | 无障碍 TYPE_WINDOW_STATE_CHANGED | 包名 + 页面类名；拿不到桌面那种窗口标题 |
//! | `window.changed` | 同上（同一 app 内页面变了） | |
//! | `ui.text` | 无障碍节点树拍平 | 语义摘要的主料 |
//! | `mouse.click` | TYPE_VIEW_CLICKED | 带元素名 |
//! | `mouse.scroll` | TYPE_VIEW_SCROLLED | |
//! | `keyboard.text_input`／`submit` | TYPE_VIEW_TEXT_CHANGED | 密码框置 `[REDACTED]` |
//! | `presence`／`heartbeat` | 屏幕状态 + 空闲 | 锁屏/息屏算离开 |
//! | `screen.*` | SCREEN_ON/OFF、USER_PRESENT | |
//!
//! ## Android 独有、桌面没有的（一并记上，摘要里可以用）
//!
//! | 事件 | 来源 | 价值 |
//! |---|---|---|
//! | `notify.posted` | NotificationListenerService | 谁发了什么通知：消息来了没看、营销推送 |
//! | `media.play` | MediaSessionManager | 在听什么、看什么 |
//! | `call.state` | PhoneStateListener（需权限） | 通话中／来电 |
//! | `battery.state` | ACTION_BATTERY_CHANGED | 充放电、低电 |
//! | `network.state` | ConnectivityManager | 断网（接口调试、同步失败的线索） |
//! | `audio.route` | ACTION_HEADSET_PLUG | 插耳机（在听东西/开会） |
//! | `device.unlock` | ACTION_USER_PRESENT | 解锁次数即拿起次数 |
//! | `app.install`／`app.uninstall` | PACKAGE_ADDED/REMOVED | 试用新工具 |
//! | `doze.state` | ACTION_DEVICE_IDLE_MODE_CHANGED | 后台被限制（采集断档的解释） |
//! | `screen.on`／`screen.off` | ACTION_SCREEN_ON/OFF | 手机拿起放下 |
//!
//! 这些「Android 独有」事件摘要引擎目前不读，但先记下来——事件是只追加的，
//! 以后摘要侧想用随时能读，而漏记的时间补不回来。字段名统一用 `xxx.yyy`，与现有命名一致。

use beayy_core::{fields, EventLog};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};

use crate::common::{clean_text, flush_value, submit_cleared, truncate, Blocklist, KeyStats, UiDedupe, UiLines, UiSnapshot, VALUE_MAX};

/// Android 默认不记录的 app：密码管理器、银行、系统设置里的锁屏与账号页
pub const DEFAULT_BLOCKLIST: &[&str] = &[
    "com.1password.android",
    "com.agilebits.onepassword",
    "com.bitwarden.android",
    "com.lastpass.lpandroid",
    "com.android.settings",
];

/// 无障碍给过来的一条「界面变了」记录。字段全部是可选的：
/// 系统给不了的（比如某些 ROM 的页面类名）就留空，不要编。
#[derive(Debug, Default, Clone)]
pub struct UiEvent {
    /// 包名，如 com.ss.android.ugc.aweme
    pub package: String,
    /// 显示名，如「抖音」；Kotlin 侧查 PackageManager 得到，查不到就用包名
    pub app_name: String,
    /// 页面类名／Activity 名，当作桌面的 window_title 用
    pub class_name: String,
    /// 拍平后的界面文字（Kotlin 侧已经过滤掉控件类名，只留可见文本）
    pub text: String,
    /// 节点数（统计用）
    pub nodes: u64,
    /// 是不是因为超限被截断
    pub truncated: bool,
    /// 界面里有没有密码框（有的话文字里已经不含密码，但仍值得标一下）
    pub secure: bool,
    /// 站点网址（浏览器／WebView），只留 http(s)
    pub url: String,
}

/// 一次打字过程的状态（和桌面 `Burst` 对应）
#[derive(Default)]
struct Burst {
    start_ms: i64,
    app: Map<String, Value>,
    window: String,
    typed: String,
    last_value: String,
    element: Option<Map<String, Value>>,
    secure: bool,
    stats: KeyStats,
}

/// Android 采集器的全部状态。所有方法都在**同一条线程**上调用（Kotlin 侧串行回调），
/// 所以内部用 `Mutex` 只是为了满足 `Sync`，不是真并发。
pub struct Capture {
    log: Arc<EventLog>,
    blocklist: Blocklist,
    ui: UiDedupe,
    burst: Burst,
    /// 上次的在场状态：true＝正在用
    active: Option<bool>,
    /// 上次心跳时刻（毫秒）
    last_heartbeat: i64,
    /// 上次读界面文字的时刻，避免同一屏反复写
    last_ui_ms: i64,
}

impl Capture {
    pub fn new(log: Arc<EventLog>) -> Capture {
        Capture {
            log,
            blocklist: Blocklist::new(DEFAULT_BLOCKLIST),
            ui: UiDedupe::default(),
            burst: Burst::default(),
            active: None,
            last_heartbeat: 0,
            last_ui_ms: 0,
        }
    }

    fn write(&self, ty: &str, f: Map<String, Value>) {
        self.log.write(ty, f, None);
    }

    /// 这个包是不是「不记录的 app」
    fn blocked(&mut self, package: &str, app_name: &str) -> bool {
        self.blocklist.reload();
        self.blocklist.blocked(0, || vec![package.to_string(), app_name.to_string()])
    }

    /// 一个 app／页面变成前台：先把上一段打字落盘，再记 `app.activated` 或 `window.changed`
    ///
    /// `same_app` 由 Kotlin 侧判断（包名没变、只是页面换了）：那样记 `window.changed`，
    /// 和桌面「同一个 app 换窗口」一致。
    pub fn foreground(&mut self, e: &UiEvent, same_app: bool) {
        self.flush_text("app_switch");
        if self.blocked(&e.package, &e.app_name) {
            // 不记录的 app：只记「切到了它」（时长才算得对），页面文字一律不记
            let mut f = self.app_fields(e);
            f.insert("blocked".into(), json!(true));
            self.write("app.activated", f);
            return;
        }
        if same_app {
            let mut f = self.app_fields(e);
            f.insert("window_title".into(), json!(e.class_name));
            f.insert("change".into(), json!("class_changed"));
            self.write("window.changed", f);
        } else {
            let mut f = self.app_fields(e);
            f.insert("window_title".into(), json!(e.class_name));
            self.write("app.activated", f);
        }
    }

    /// 界面文字：内容没变就不重复写（`UiDedupe` 按「pid|标题」记上次的哈希，这里 pid 恒为 0，
    /// 所以键实际是「|类名」——同 app 同页面才去重，跨 app 不会误吞）
    pub fn ui_text(&mut self, e: &UiEvent, trigger: &str) {
        if self.blocked(&e.package, &e.app_name) {
            return;
        }
        let now = now_ms();
        // 30 秒内同一页面不重复读（和桌面的 UI_REFRESH 一致）
        if now - self.last_ui_ms < 30_000 && self.burst.window == e.class_name {
            return;
        }
        self.last_ui_ms = now;
        let mut lines = UiLines::default();
        for line in e.text.lines() {
            let t = clean_text(line);
            if !t.is_empty() {
                lines.add(t);
                if lines.full() {
                    break;
                }
            }
        }
        let snap = UiSnapshot {
            app: self.app_fields(e),
            window_title: e.class_name.clone(),
            trigger: trigger.to_string(),
            lines,
            visited: e.nodes as usize,
            truncated: e.truncated,
            url: e.url.clone(),
            secure: e.secure,
        };
        self.ui.write(&self.log, snap);
    }

    /// 点了一下：`mouse.click`，带元素名（桌面点带元素，这里同理）
    pub fn click(&mut self, e: &UiEvent, button: &str, element: Option<Map<String, Value>>) {
        if self.blocked(&e.package, &e.app_name) {
            return;
        }
        let mut f = self.app_fields(e);
        f.insert("window_title".into(), json!(e.class_name));
        f.insert("button".into(), json!(button));
        if let Some(el) = element {
            f.insert("element".into(), Value::Object(el));
        }
        self.write("mouse.click", f);
    }

    /// 滚了一下
    pub fn scroll(&mut self, e: &UiEvent, direction: &str) {
        if self.blocked(&e.package, &e.app_name) {
            return;
        }
        let mut f = self.app_fields(e);
        f.insert("window_title".into(), json!(e.class_name));
        f.insert("direction".into(), json!(direction));
        self.write("mouse.scroll", f);
    }

    /// 输入框内容变了。
    ///
    /// `value` 是输入框**当前的全部内容**（不是这一次按的键）。`is_password` 为真时
    /// 一律记 `[REDACTED]`——和桌面 `emit_text` 的处理一致，密码不落盘。
    pub fn text_changed(&mut self, e: &UiEvent, value: &str, is_password: bool) {
        if self.blocked(&e.package, &e.app_name) {
            return;
        }
        let now = now_ms();
        if self.burst.start_ms == 0 {
            self.burst.start_ms = now;
            self.burst.app = self.app_fields(e);
            self.burst.window = e.class_name.clone();
        }
        self.burst.secure = is_password;
        if !is_password {
            let v = truncate(value, VALUE_MAX);
            if !v.is_empty() {
                self.burst.last_value = v;
            }
        }
        self.burst.stats.note(&json!({"kind": "human"}));
    }

    /// 回车／发送：判断是「发出去了」还是只是换行
    ///
    /// 和桌面同一套判据（`submit_cleared`）：输入框里已经没有刚才打的字＝发送。
    /// 中文输入法上屏时会把拼音字母留下，`still_contains` 已经处理了那种情况。
    pub fn submit(&mut self, e: &UiEvent, value_after: &str, is_password: bool) {
        if self.blocked(&e.package, &e.app_name) {
            return;
        }
        let before = if is_password { String::new() } else { self.burst.last_value.clone() };
        let after = if is_password { String::new() } else { clean_text(value_after) };
        if is_password {
            self.emit_text(e, "keyboard.submit", "[REDACTED]", "return_cleared", None);
            self.reset_burst();
            return;
        }
        if submit_cleared(&before, &after) {
            self.emit_text(e, "keyboard.submit", &before, "return_cleared", None);
            self.reset_burst();
        } else if self.burst.start_ms != 0 {
            self.emit_text(e, "keyboard.text_input", &flush_value(after.clone(), &before), "burst", None);
            self.reset_burst();
        } else {
            let mut f = self.app_fields(e);
            f.insert("actor".into(), json!({"kind": "human"}));
            self.write("keyboard.return", f);
        }
    }

    /// 把这一段的打字落盘（切 app、停下、锁屏时调）
    pub fn flush_text(&mut self, reason: &str) {
        if self.burst.start_ms == 0 {
            return;
        }
        let text = if self.burst.secure { "[REDACTED]".to_string() } else { self.burst.last_value.clone() };
        let e = UiEvent {
            package: str_of(&self.burst.app, "bundle_id"),
            app_name: str_of(&self.burst.app, "app_name"),
            class_name: self.burst.window.clone(),
            ..Default::default()
        };
        self.emit_text(&e, "keyboard.text_input", &text, reason, None);
        self.reset_burst();
    }

    fn emit_text(&mut self, e: &UiEvent, ty: &str, text: &str, reason: &str, actor: Option<Value>) {
        let mut f = if self.burst.app.is_empty() { self.app_fields(e) } else { self.burst.app.clone() };
        let window = if self.burst.window.is_empty() { e.class_name.clone() } else { self.burst.window.clone() };
        f.insert("window_title".into(), json!(window));
        f.insert("text".into(), json!(text));
        f.insert("typed".into(), json!(if self.burst.secure { "[REDACTED]" } else { text }));
        f.insert("reason".into(), json!(reason));
        self.burst.stats.fill(&mut f);
        if let Some(a) = actor {
            f.insert("submit_actor".into(), a);
        }
        if let Some(el) = self.burst.element.clone() {
            f.insert("element".into(), Value::Object(el));
        }
        self.write(ty, f);
    }

    fn reset_burst(&mut self) {
        self.burst = Burst::default();
    }

    /// 在场／心跳：锁屏和息屏都算离开（和桌面 `presence_tick` 同一套判断）
    pub fn presence(&mut self, interactive: bool, locked: bool, idle_seconds: f64) {
        let now = now_ms();
        let now_active = interactive && !locked && idle_seconds < crate::common::IDLE_THRESHOLD;
        if self.active != Some(now_active) {
            self.write(
                "presence",
                fields! {"state" => if now_active { "active" } else { "idle" }, "idle_seconds" => idle_seconds as i64},
            );
            self.active = Some(now_active);
        }
        if now - self.last_heartbeat >= 60_000 {
            let mut f = fields! {"idle_seconds" => idle_seconds as i64, "state" => if now_active { "active" } else { "idle" }};
            if !now_active {
                self.flush_text("idle");
            }
            self.write("heartbeat", std::mem::take(&mut f));
            self.last_heartbeat = now;
        }
    }

    // ---------- Android 独有的事件 ----------

    /// 来了一条通知。只记「谁发的、什么标题」，正文默认不记（可能含验证码、私密消息）；
    /// 想记正文要用户显式打开 `include_text`。
    pub fn notification(&mut self, package: &str, app_name: &str, title: &str, text: &str, include_text: bool) {
        if self.blocked(package, app_name) {
            return;
        }
        let mut f = fields! {
            "package_name" => package,
            "app_name" => if app_name.is_empty() { package } else { app_name },
            "title" => truncate(&clean_text(title), 200),
        };
        if include_text && !text.is_empty() {
            f.insert("text".into(), json!(truncate(&clean_text(text), 500)));
        }
        self.write("notify.posted", f);
    }

    /// 在听／在看什么（媒体会话）
    pub fn media(&mut self, package: &str, app_name: &str, title: &str, artist: &str, playing: bool) {
        if self.blocked(package, app_name) {
            return;
        }
        self.write(
            "media.play",
            fields! {
                "package_name" => package,
                "app_name" => if app_name.is_empty() { package } else { app_name },
                "title" => truncate(&clean_text(title), 200),
                "artist" => truncate(&clean_text(artist), 120),
                "state" => if playing { "playing" } else { "paused" },
            },
        );
    }

    /// 电量：只在跨过阈值或充放电状态变化时记，别每 1% 写一条
    pub fn battery(&mut self, percent: i64, charging: bool, plugged: &str) {
        self.write(
            "battery.state",
            fields! {"percent" => percent, "charging" => charging, "plugged" => plugged},
        );
    }

    /// 网络状态变化：断网是「同步失败／接口调不通」的重要线索
    pub fn network(&mut self, kind: &str, online: bool, metered: bool) {
        self.write("network.state", fields! {"type" => kind, "online" => online, "metered" => metered});
    }

    /// 屏幕亮灭／解锁
    pub fn screen(&mut self, event: &'static str) {
        match event {
            "screen.off" | "screen.on" => {}
            _ => return,
        }
        self.write(event, Map::new());
        if event == "screen.off" {
            self.flush_text("screen_off");
        }
    }

    /// 解锁（拿起手机用）
    pub fn unlock(&mut self) {
        self.write("device.unlock", Map::new());
    }

    /// 插拔耳机
    pub fn headset(&mut self, plugged: bool) {
        self.write("audio.route", fields! {"headset" => plugged});
    }

    /// 装／卸 app：试用新工具的痕迹
    pub fn package_change(&mut self, package: &str, installed: bool) {
        self.write(if installed { "app.install" } else { "app.uninstall" }, fields! {"package_name" => package});
    }

    /// 屏幕使用：哪个 app 进了前台／退到后台。字段和 iPhone 的 `app.focus` 对齐
    /// （`state` / `biome_time` / `source`），所以 `data.rs` 的手机统计不用区分平台。
    ///
    /// 事件时间用 `biome_time`（UsageStatsManager 给的历史时刻）而不是「现在」——
    /// 补采的是过去几分钟的活动，写错时间会落到别的 10 分钟分段里去。
    pub fn focus(&mut self, package: &str, app_name: &str, state: &str, biome_time: f64, source: &str) {
        if !matches!(state, "start" | "end") || package.is_empty() {
            return;
        }
        let f = fields! {
            "state" => state,
            "bundle_id" => package,
            "package_name" => package,
            "app_name" => if app_name.is_empty() { package } else { app_name },
            "biome_time" => biome_time,
            "source" => if source.is_empty() { "android:UsageStatsManager" } else { source },
            "recorded_at" => beayy_core::iso(chrono::Utc::now()),
        };
        let at = chrono::DateTime::<chrono::Utc>::from_timestamp_micros((biome_time * 1e6) as i64);
        self.log.write("app.focus", f, at);
    }
    /// 通话状态（需要 READ_PHONE_STATE）
    pub fn call(&mut self, state: &str) {
        self.write("call.state", fields! {"state" => state});
    }

    /// 进／出省电模式：后台被限制，采集会有断档，记下来好解释
    pub fn doze(&mut self, idle: bool) {
        self.write("doze.state", fields! {"idle" => idle});
    }

    /// 无障碍服务本身的状态，和桌面的 `tap.started`／`tap.failed` 对齐
    pub fn service_state(&mut self, event: &'static str, error: Option<&str>) {
        match event {
            "started" | "reenabled" | "failed" => {}
            _ => return,
        }
        let mut f = Map::new();
        if let Some(e) = error {
            f.insert("error".into(), json!(e));
        }
        self.write(if event == "failed" { "tap.failed" } else { "tap.started" }, f);
    }

    /// 暂停／继续（用户点了设置里的暂停）
    pub fn paused(&mut self, p: bool) {
        self.write(if p { "app.paused" } else { "app.resumed" }, Map::new());
    }

    // ---------- 小工具 ----------
    fn app_fields(&self, e: &UiEvent) -> Map<String, Value> {
        let mut f = fields! {
            "app_name" => if e.app_name.is_empty() { &e.package } else { &e.app_name },
            "bundle_id" => &e.package,
            "package_name" => &e.package,
            "pid" => 0,
        };
        if !e.class_name.is_empty() { f.insert("class_name".into(), json!(e.class_name)); }
        f
    }
}

fn str_of(m: &Map<String, Value>, k: &str) -> String {
    m.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 全局单例：Kotlin 侧通过 JNI 调下面这些函数，不需要自己管生命周期
static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Capture) -> R) -> Option<R> {
    let mut g = CAPTURE.lock().ok()?;
    g.as_mut().map(f)
}

/// 启动采集（Kotlin 侧在 Application.onCreate 里调一次）
pub fn start(log: Arc<EventLog>) {
    if let Ok(mut g) = CAPTURE.lock() {
        if g.is_none() {
            *g = Some(Capture::new(log));
        }
    }
}

/// 供 JNI 层调用的入口。参数都是从 Kotlin 打包好的 JSON，避免在 FFI 上铺太多字段。
pub fn dispatch(op: &str, args: &Value) -> Result<(), String> {
    let ui_event = || {
        let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        UiEvent {
            package: s("package"),
            app_name: s("app_name"),
            class_name: s("class_name"),
            text: s("text"),
            nodes: args.get("nodes").and_then(Value::as_u64).unwrap_or(0),
            truncated: args.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            secure: args.get("secure").and_then(Value::as_bool).unwrap_or(false),
            url: s("url"),
        }
    };
    let b = |k: &str| args.get(k).and_then(Value::as_bool).unwrap_or(false);
    let i = |k: &str| args.get(k).and_then(Value::as_i64).unwrap_or(0);
    let f = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let el = |k: &str| args.get(k).and_then(Value::as_object).cloned();

    const OPS: &[&str] = &[
        "foreground", "ui_text", "click", "scroll", "text_changed", "submit", "flush_text", "presence",
        "notification", "media", "battery", "network", "screen_on", "screen_off", "unlock", "headset",
        "install", "uninstall", "call", "doze", "service_started", "service_failed", "paused", "resumed", "focus",
    ];
    if !OPS.contains(&op) {
        return Err(format!("android 采集没有这个操作：{op}"));
    }
    let r = with(|c| match op {
        "foreground" => c.foreground(&ui_event(), b("same_app")),
        "ui_text" => c.ui_text(&ui_event(), &s("trigger")),
        "click" => c.click(&ui_event(), &s("button"), el("element")),
        "scroll" => c.scroll(&ui_event(), &s("direction")),
        "text_changed" => c.text_changed(&ui_event(), &s("value"), b("is_password")),
        "submit" => c.submit(&ui_event(), &s("value"), b("is_password")),
        "flush_text" => c.flush_text(&s("reason")),
        "presence" => c.presence(b("interactive"), b("locked"), f("idle_seconds")),
        "notification" => c.notification(&s("package"), &s("app_name"), &s("title"), &s("text"), b("include_text")),
        "media" => c.media(&s("package"), &s("app_name"), &s("title"), &s("artist"), b("playing")),
        "battery" => c.battery(i("percent"), b("charging"), &s("plugged")),
        "network" => c.network(&s("type"), b("online"), b("metered")),
        "screen_on" => c.screen("screen.on"),
        "focus" => c.focus(&s("package"), &s("app_name"), &s("state"), f("biome_time"), &s("source")),
        "screen_off" => c.screen("screen.off"),
        "unlock" => c.unlock(),
        "headset" => c.headset(b("plugged")),
        "install" => c.package_change(&s("package"), true),
        "uninstall" => c.package_change(&s("package"), false),
        "call" => c.call(&s("state")),
        "doze" => c.doze(b("idle")),
        "service_started" => c.service_state("started", None),
        "service_failed" => c.service_state("failed", Some(&s("error"))),
        "paused" => c.paused(true),
        _ => c.paused(false),
    });
    r.ok_or_else(|| "android 采集还没启动".to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn temp_log(name: &str) -> (Arc<EventLog>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("beayy-android-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = Arc::new(EventLog::new(dir.clone(), "android-test"));
        (log, dir)
    }

    fn read_all(log: &EventLog) -> Vec<Value> {
        let mut out = vec![];
        if let Ok(dirs) = std::fs::read_dir(log.segments_dir()) {
            for d in dirs.filter_map(|e| e.ok()) {
                if let Ok(b) = std::fs::read(d.path().join("events.jsonl")) {
                    for line in String::from_utf8_lossy(&b).lines() {
                        if let Ok(v) = serde_json::from_str::<Value>(line) {
                            out.push(v);
                        }
                    }
                }
            }
        }
        out
    }

    #[test]
    fn foreground_and_ui_text_use_desktop_field_names() {
        let (log, dir) = temp_log("fg");
        let mut c = Capture::new(log.clone());
        let e = UiEvent {
            package: "com.example.app".into(),
            app_name: "示例".into(),
            class_name: "MainActivity".into(),
            text: "第一行\n第二行".into(),
            nodes: 12,
            ..Default::default()
        };
        c.foreground(&e, false);
        c.ui_text(&e, "app_activated");
        let ev = read_all(&log);
        let act = ev.iter().find(|x| x["event_type"] == "app.activated").unwrap();
        // 摘要引擎靠这几个字段：app_name / bundle_id / window_title
        assert_eq!(act["app_name"], "示例");
        assert_eq!(act["bundle_id"], "com.example.app");
        assert_eq!(act["window_title"], "MainActivity");
        let ui = ev.iter().find(|x| x["event_type"] == "ui.text").unwrap();
        assert_eq!(ui["text"], "第一行\n第二行");
        assert_eq!(ui["lines"], 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn password_never_lands_on_disk() {
        let (log, dir) = temp_log("pwd");
        let mut c = Capture::new(log.clone());
        let e = UiEvent { package: "com.bank".into(), app_name: "银行".into(), class_name: "Login".into(), ..Default::default() };
        c.text_changed(&e, "hunter2", true);
        c.submit(&e, "", true);
        let ev = read_all(&log);
        let text = serde_json::to_string(&ev).unwrap();
        assert!(!text.contains("hunter2"), "密码写进了磁盘：{text}");
        assert!(text.contains("[REDACTED]"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn submit_detection_reuses_common_rules() {
        let (log, dir) = temp_log("submit");
        let mut c = Capture::new(log.clone());
        let e = UiEvent { package: "com.msg".into(), app_name: "聊天".into(), class_name: "Chat".into(), ..Default::default() };
        c.text_changed(&e, "你好，测试。", false);
        // 输入框清空＝发了
        c.submit(&e, "", false);
        let ev = read_all(&log);
        let sub = ev.iter().find(|x| x["event_type"] == "keyboard.submit").expect("没记到发送");
        assert_eq!(sub["text"], "你好，测试。");
        // 中文输入法上屏不算发送
        c.text_changed(&e, "你好liu'b", false);
        c.submit(&e, "你好liub", false);
        assert!(!read_all(&log).iter().any(|x| x["event_type"] == "keyboard.submit" && x["reason"] == "return_cleared" && x["text"] == "你好liu'b"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn blocked_app_records_only_the_switch() {
        let (log, dir) = temp_log("block");
        let mut c = Capture::new(log.clone());
        let e = UiEvent {
            package: "com.1password.android".into(),
            app_name: "1Password".into(),
            class_name: "Vault".into(),
            text: "我的密码本".into(),
            ..Default::default()
        };
        c.foreground(&e, false);
        c.ui_text(&e, "app_activated");
        let ev = read_all(&log);
        assert!(ev.iter().any(|x| x["event_type"] == "app.activated" && x["blocked"] == true));
        assert!(!ev.iter().any(|x| x["event_type"] == "ui.text"), "黑名单里的 app 不该记界面文字");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn presence_and_android_only_events() {
        let (log, dir) = temp_log("misc");
        let mut c = Capture::new(log.clone());
        c.presence(true, false, 0.0);
        c.presence(false, true, 200.0);
        c.notification("com.tencent.mm", "微信", "张三", "在吗", false);
        c.media("com.netease.cloudmusic", "网易云音乐", "某首歌", "某人", true);
        c.battery(42, true, "usb");
        c.network("wifi", true, false);
        c.headset(true);
        c.package_change("com.new.app", true);
        let ev = read_all(&log);
        for ty in ["presence", "notify.posted", "media.play", "battery.state", "network.state", "audio.route", "app.install"] {
            assert!(ev.iter().any(|x| x["event_type"] == ty), "没记到 {ty}");
        }
        // 通知默认不记正文
        let n = ev.iter().find(|x| x["event_type"] == "notify.posted").unwrap();
        assert!(n.get("text").is_none(), "通知正文不该默认落盘");
        assert_eq!(n["title"], "张三");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn dispatch_rejects_unknown_op() {
        assert!(dispatch("nope", &json!({})).is_err());
    }

    /// app.focus 的字段要和 iPhone 的 biome 事件对得上（data.rs 靠这几个字段算手机时长）
    #[test]
    fn focus_matches_iphone_fields() {
        let (log, dir) = temp_log("focus");
        let mut c = Capture::new(log.clone());
        let t = 1_760_000_000.0_f64; // 秒
        c.focus("com.tencent.mm", "微信", "start", t, "android:UsageStatsManager");
        c.focus("com.tencent.mm", "微信", "end", t + 120.0, "");
        // 非法 state 不写
        c.focus("com.x", "未知", "bogus", t, "");

        let ev = read_all(&log);
        let focus: Vec<_> = ev.iter().filter(|x| x["event_type"] == "app.focus").collect();
        assert_eq!(focus.len(), 2, "两条合法记录都该写进去");
        assert_eq!(focus[0]["state"], "start");
        assert_eq!(focus[0]["bundle_id"], "com.tencent.mm");
        assert_eq!(focus[0]["biome_time"], t);
        assert_eq!(focus[0]["source"], "android:UsageStatsManager");
        // source 空时补默认值
        assert_eq!(focus[1]["source"], "android:UsageStatsManager");
        let _ = std::fs::remove_dir_all(dir);
    }
}
