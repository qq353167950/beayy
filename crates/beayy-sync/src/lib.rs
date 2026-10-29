//! 多设备同步客户端。协议见 报告/方案_20261016_多设备同步.md，服务端在 app/server/。
//!
//! - 同步单位是一个分段文件 `devices/<设备>/segments/<分段>/events.jsonl`；本机写的 10 分钟摘要也同步，
//!   块名 `sum.<摘要文件名>`，别的设备下载到 `devices/<设备>/summaries/<摘要文件名>`（时间线显示是哪台电脑的）。
//! - 设备改名：每台设备把自己改过的名字写在 `<数据根>/device_names.json`（{设备: {name, at}}），块名 `names.json`
//!   同步；别的设备下载到 `devices/<设备>/device_names.json`，读取时按改名时刻取最新的。
//! - 下载来的设备目录里放一个 `.synced` 标记：换账号、重登录清了状态以后，也不会把别人的数据当成自己的再传上去。
//! - 上传前先 deflate 压缩，再用 XChaCha20-Poly1305 加密（随机 24 字节 nonce 放在密文前，AAD＝`<设备>/<分段>`）；
//!   密钥只在设备上（钥匙串），服务器读不到内容。
//! - 本机写的设备（本机电脑、本机读到的 iPhone）只上传；别的设备只下载，写到同样的位置，读取方不用改。
//! - 状态在 `<数据根>/sync/state.json`：每个分段上次上传时的大小和修改时间、下载游标、哪些设备是同步来的。
//! - 账号（v2）：邮箱＋主密码。主密码用 Argon2id 派生成主钥，再用 HKDF 分出「登录校验值」（发给服务器，服务器只存它的哈希）
//!   和「包钥」（在本机解开服务器上包好的数据密钥）。恢复码就是数据密钥本身（base32 分组），忘了主密码时用它重设。
//!   每台设备登录拿自己的令牌。v1 的配对码账号用 claim 迁移：同一把数据密钥，已上传的数据不用重传。

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

pub const DEFAULT_SERVER: &str = "https://6000-agqwfq6g2fpunw4so7aocow6pu.instabox.tech";
const CODE_PREFIX: &str = "beayy-sync-1:";
const PARALLEL: usize = 8;
/// 下载并发：每块都要过一次鉴权查库，单次慢，多开几路
const PARALLEL_DOWN: usize = 16;

/// 一个同步账号：服务器、账号、邮箱（v1 迁移前没有）、这台设备的令牌（只管能不能存取）、数据密钥（加解密，只在设备上）
#[derive(Clone)]
pub struct Account {
    pub server: String,
    pub user: String,
    pub email: Option<String>,
    token: String,
    key: [u8; 32],
}

impl Account {
    /// 配对码：新设备粘贴它就加入同一账号。它等于全部数据的钥匙
    pub fn code(&self) -> String {
        let j = json!({"s": self.server, "u": self.user, "t": self.token, "k": B64.encode(self.key), "e": self.email});
        format!("{CODE_PREFIX}{}", B64.encode(j.to_string()))
    }

    pub fn from_code(code: &str) -> Result<Account, String> {
        let body = code.trim().strip_prefix(CODE_PREFIX).ok_or("配对码不对：应以 beayy-sync-1: 开头")?;
        let raw = B64.decode(body.trim()).map_err(|_| "配对码不对：解不开")?;
        let j: Value = serde_json::from_slice(&raw).map_err(|_| "配对码不对：内容坏了")?;
        let key = B64.decode(j["k"].as_str().unwrap_or("")).map_err(|_| "配对码不对：密钥坏了")?;
        Ok(Account {
            server: j["s"].as_str().unwrap_or(DEFAULT_SERVER).trim_end_matches('/').to_string(),
            user: j["u"].as_str().ok_or("配对码不对：缺账号")?.to_string(),
            email: j["e"].as_str().map(String::from),
            token: j["t"].as_str().ok_or("配对码不对：缺令牌")?.to_string(),
            key: key.try_into().map_err(|_| "配对码不对：密钥长度不对")?,
        })
    }

    fn auth(&self) -> String {
        format!("Bearer {}:{}", self.user, self.token)
    }

    fn cipher(&self) -> XChaCha20Poly1305 {
        XChaCha20Poly1305::new((&self.key).into())
    }
}

// ---------- 账号存放：默认数据目录存钥匙串，其他（测试用的 BEAYY_DATA_ROOT、Windows）存数据目录里的文件 ----------

fn use_keychain() -> bool {
    cfg!(target_os = "macos") && std::env::var("BEAYY_DATA_ROOT").is_err()
}

fn account_file(root: &Path) -> PathBuf {
    root.join("sync").join("account")
}

pub fn load(root: &Path) -> Option<Account> {
    let code = if use_keychain() {
        let o = std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "com.fengli.beayy", "-a", "sync", "-w"])
            .output()
            .ok()?;
        if !o.status.success() {
            return None;
        }
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    } else {
        fs::read_to_string(account_file(root)).ok()?
    };
    Account::from_code(&code).ok()
}

fn save(root: &Path, a: &Account) -> Result<(), String> {
    if use_keychain() {
        let ok = std::process::Command::new("/usr/bin/security")
            .args(["add-generic-password", "-U", "-s", "com.fengli.beayy", "-a", "sync", "-w", &a.code()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        return if ok { Ok(()) } else { Err("写入钥匙串失败".into()) };
    }
    let f = account_file(root);
    fs::create_dir_all(f.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&f, a.code()).map_err(|e| e.to_string())
}

/// 本机退出同步：忘掉账号（服务器上的数据不动）。同步进度留着，同一个账号再登录不用从头重传
pub fn forget(root: &Path) {
    if use_keychain() {
        let _ = std::process::Command::new("/usr/bin/security").args(["delete-generic-password", "-s", "com.fengli.beayy", "-a", "sync"]).output();
    }
    let _ = fs::remove_file(account_file(root));
}

/// 登录或注册之后：换了账号才清同步进度（上传记录、下载游标都是按账号的）；同一个账号只清掉「要重新登录」和上次的错
fn reset_state_for(root: &Path, user: &str) {
    let mut st = read_state(root);
    if st.raw.get("user").and_then(Value::as_str) != Some(user) {
        let _ = fs::remove_file(state_path(root));
        return;
    }
    st.raw.insert("need_login".into(), json!(false));
    st.raw.insert("last_error".into(), Value::Null);
    write_state(root, &st);
}

// ---------- HTTP ----------

fn agent() -> ureq::Agent {
    // 根证书的来源按平台选：
    // - 桌面（默认 feature native-tls）：用系统根证书（macOS 钥匙串、Windows 证书库）。
    //   ureq 内置的清单会关掉系统根证书，Windows 上验不过 Cloudflare 的证书链。
    // - Android（feature rustls）：NDK 没有可用的系统 TLS 库，改用 rustls + ureq 自带的根证书。
    #[cfg(not(feature = "rustls"))]
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    #[cfg(feature = "rustls")]
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::Rustls)
        .root_certs(ureq::tls::RootCerts::WebPki)
        .build();
    ureq::Agent::config_builder()
        .proxy(None)
        .tls_config(tls)
        .timeout_global(Some(Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn err_of(mut r: ureq::http::Response<ureq::Body>) -> String {
    let status = r.status().as_u16();
    let msg = r.body_mut().read_json::<Value>().ok().and_then(|v| v["error"].as_str().map(String::from)).unwrap_or_default();
    format!("服务器返回 {status} {msg}")
}



/// 服务器上这个账号的设备：[{device, segments, bytes, updated}]
pub fn remote_devices(a: &Account) -> Result<Vec<Value>, String> {
    let r = agent().get(&format!("{}/v1/devices", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    let mut r = r;
    let v: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
    Ok(v["devices"].as_array().cloned().unwrap_or_default())
}

// ---------- 账号（v2）：邮箱＋主密码 ----------

/// 主密码 → (登录校验值 hex, 包钥)。Argon2id m=64MB t=3 p=1，盐由服务器存（每个账号随机 16 字节）
fn derive(password: &str, salt_hex: &str) -> Result<(String, [u8; 32]), String> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let salt = hex_decode(salt_hex).ok_or("盐不对")?;
    let mut master = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(65536, 3, 1, Some(32)).map_err(|e| e.to_string())?)
        .hash_password_into(password.as_bytes(), &salt, &mut master)
        .map_err(|e| e.to_string())?;
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, &master);
    let (mut auth, mut wrap) = ([0u8; 32], [0u8; 32]);
    hk.expand(b"beayy auth", &mut auth).map_err(|_| "派生失败")?;
    hk.expand(b"beayy wrap", &mut wrap).map_err(|_| "派生失败")?;
    Ok((hex_encode(&auth), wrap))
}

/// 恢复码的校验值：从数据密钥派生（服务器只存它的哈希）
fn recovery_auth(key: &[u8; 32]) -> String {
    let mut out = [0u8; 32];
    let _ = hkdf::Hkdf::<sha2::Sha256>::new(None, key).expand(b"beayy recovery", &mut out);
    hex_encode(&out)
}

fn wrap_key(data: &[u8; 32], wrap: &[u8; 32]) -> Result<String, String> {
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let ct = XChaCha20Poly1305::new(wrap.into())
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: data, aad: b"beayy-data-key" })
        .map_err(|_| "加密失败")?;
    Ok(B64.encode([nonce.to_vec(), ct].concat()))
}

fn unwrap_key(wrapped: &str, wrap: &[u8; 32]) -> Result<[u8; 32], String> {
    let b = B64.decode(wrapped).map_err(|_| "数据密钥坏了")?;
    if b.len() < 24 {
        return Err("数据密钥坏了".into());
    }
    let pt = XChaCha20Poly1305::new(wrap.into())
        .decrypt(XNonce::from_slice(&b[..24]), Payload { msg: &b[24..], aad: b"beayy-data-key" })
        .map_err(|_| "主密码不对，解不开数据密钥")?;
    pt.try_into().map_err(|_| "数据密钥长度不对".to_string())
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    (0..s.len()).step_by(2).map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok())).collect()
}

const B32: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 I O 0 1，抄写不易错

/// 恢复码：数据密钥的 base32，每 4 个字一组
pub fn recovery_code_of(key: &[u8; 32]) -> String {
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = String::new();
    for &b in key {
        bits = (bits << 8) | b as u32;
        n += 8;
        while n >= 5 {
            out.push(B32[((bits >> (n - 5)) & 31) as usize] as char);
            n -= 5;
        }
    }
    if n > 0 {
        out.push(B32[((bits << (5 - n)) & 31) as usize] as char);
    }
    out.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

fn parse_recovery(code: &str) -> Result<[u8; 32], String> {
    let mut bits = 0u32;
    let mut n = 0;
    let mut out = vec![];
    for c in code.chars().filter(|c| c.is_ascii_alphanumeric()) {
        let c = c.to_ascii_uppercase();
        let v = B32.iter().position(|x| *x as char == c).ok_or("恢复码里有不认识的字")?;
        bits = (bits << 5) | v as u32;
        n += 5;
        if n >= 8 {
            out.push(((bits >> (n - 8)) & 255) as u8);
            n -= 8;
        }
    }
    out.truncate(32);
    out.try_into().map_err(|_| "恢复码长度不对".to_string())
}

fn post_json(ag: &ureq::Agent, url: &str, auth: Option<&str>, body: &Value) -> Result<Value, String> {
    let mut rq = ag.post(url);
    if let Some(a) = auth {
        rq = rq.header("Authorization", a);
    }
    let r = rq.send_json(body).map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    let mut r = r;
    r.body_mut().read_json().map_err(|e| e.to_string())
}

fn new_salt() -> Result<String, String> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
    Ok(hex_encode(&salt))
}

/// 新账号：生成数据密钥，主密码包一层存上去；返回恢复码（只在这时给用户看一次，之后设置里也能再看）
pub fn signup(root: &Path, server: &str, invite: &str, email: &str, password: &str, device: &str, name: &str) -> Result<String, String> {
    let server = server.trim_end_matches('/');
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|e| e.to_string())?;
    let salt = new_salt()?;
    let (auth, wrap) = derive(password, &salt)?;
    let v = post_json(&agent(), &format!("{server}/v2/register"), None, &json!({
        "invite": invite, "email": email, "salt": salt, "auth": auth, "wrapped_key": wrap_key(&key, &wrap)?,
        "recovery": recovery_auth(&key), "device": device, "name": name,
    }))?;
    let a = Account {
        server: server.into(),
        user: v["user"].as_str().ok_or("注册结果缺账号")?.into(),
        email: Some(email.trim().to_lowercase()),
        token: v["token"].as_str().ok_or("注册结果缺令牌")?.into(),
        key,
    };
    save(root, &a)?;
    reset_state_for(root, &a.user);
    Ok(recovery_code_of(&key))
}

/// 登录已有账号：取盐 → 派生 → 拿设备令牌和包好的数据密钥 → 本机解开
pub fn login(root: &Path, server: &str, email: &str, password: &str, device: &str, name: &str) -> Result<(), String> {
    let server = server.trim_end_matches('/');
    let ag = agent();
    let email = email.trim().to_lowercase();
    let mut r = ag.get(&format!("{server}/v2/prelogin?email={}", url_escape(&email))).call().map_err(|e| e.to_string())?;
    let pre: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
    let (auth, wrap) = derive(password, pre["salt"].as_str().unwrap_or(""))?;
    let v = post_json(&ag, &format!("{server}/v2/login"), None, &json!({"email": email, "auth": auth, "device": device, "name": name}))?;
    let key = unwrap_key(v["wrapped_key"].as_str().unwrap_or(""), &wrap)?;
    let a = Account { server: server.into(), user: v["user"].as_str().unwrap_or("").into(), email: Some(email), token: v["token"].as_str().unwrap_or("").into(), key };
    save(root, &a)?;
    reset_state_for(root, &a.user);
    Ok(())
}

/// v1 配对码账号设邮箱和主密码：同一把数据密钥包一层存上去，已上传的不用重传；这台设备换成自己的令牌。返回恢复码
pub fn claim(root: &Path, email: &str, password: &str, device: &str, name: &str) -> Result<String, String> {
    let a = load(root).ok_or("这台电脑还没开同步")?;
    let salt = new_salt()?;
    let (auth, wrap) = derive(password, &salt)?;
    let v = post_json(&agent(), &format!("{}/v2/claim", a.server), Some(&a.auth()), &json!({
        "email": email, "salt": salt, "auth": auth, "wrapped_key": wrap_key(&a.key, &wrap)?,
        "recovery": recovery_auth(&a.key), "device": device, "name": name,
    }))?;
    let b = Account { email: Some(email.trim().to_lowercase()), token: v["token"].as_str().ok_or("缺令牌")?.into(), ..a };
    save(root, &b)?;
    Ok(recovery_code_of(&b.key))
}

/// 忘了主密码：恢复码＋新主密码。之前登录的设备会全部登出，这台重新登录
pub fn recover(root: &Path, server: &str, email: &str, code: &str, new_password: &str, device: &str, name: &str) -> Result<(), String> {
    let server = server.trim_end_matches('/');
    let key = parse_recovery(code)?;
    let salt = new_salt()?;
    let (auth, wrap) = derive(new_password, &salt)?;
    post_json(&agent(), &format!("{server}/v2/recover"), None, &json!({
        "email": email.trim().to_lowercase(), "recovery": recovery_auth(&key), "salt": salt, "auth": auth, "wrapped_key": wrap_key(&key, &wrap)?,
    }))?;
    login(root, server, email, new_password, device, name)
}

/// 改主密码（已登录）：数据密钥不变，重新包一层
pub fn change_password(root: &Path, new_password: &str) -> Result<(), String> {
    let a = load(root).ok_or("没登录")?;
    let salt = new_salt()?;
    let (auth, wrap) = derive(new_password, &salt)?;
    post_json(&agent(), &format!("{}/v2/password", a.server), Some(&a.auth()), &json!({"salt": salt, "auth": auth, "wrapped_key": wrap_key(&a.key, &wrap)?}))?;
    Ok(())
}

/// 账号信息：邮箱、登录着的设备
pub fn account(root: &Path) -> Result<Value, String> {
    let a = load(root).ok_or("没登录")?;
    let r = agent().get(&format!("{}/v2/account", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    let mut r = r;
    r.body_mut().read_json().map_err(|e| e.to_string())
}

/// 移除一台设备的登录（id＝"self" 就是这台退出）
pub fn remove_session(root: &Path, id: &str) -> Result<(), String> {
    let a = load(root).ok_or("没登录")?;
    let r = agent().delete(&format!("{}/v2/sessions/{id}", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    Ok(())
}

/// 退出登录：服务器上注销这台的令牌，本机忘掉账号
pub fn logout(root: &Path) {
    let _ = remove_session(root, "self");
    forget(root);
}

/// 存账号的显示名称和头像（data URL）；返回服务器记的更新时刻
pub fn set_profile(root: &Path, name: &str, avatar: Option<&str>) -> Result<i64, String> {
    let a = load(root).ok_or("没登录")?;
    let v = post_json(&agent(), &format!("{}/v2/profile", a.server), Some(&a.auth()), &json!({"name": name, "avatar": avatar}))?;
    Ok(v["updated"].as_i64().unwrap_or(0))
}

/// 这台电脑上的恢复码（数据密钥）
pub fn recovery_code(root: &Path) -> Option<String> {
    load(root).map(|a| recovery_code_of(&a.key))
}

fn url_escape(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

// ---------- 加密 ----------

fn seal(a: &Account, device: &str, segment: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let packed = miniz_oxide::deflate::compress_to_vec(plain, 6);
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let aad = format!("{device}/{segment}");
    let ct = a.cipher().encrypt(XNonce::from_slice(&nonce), Payload { msg: &packed, aad: aad.as_bytes() }).map_err(|_| "加密失败")?;
    let mut out = nonce.to_vec();
    out.extend(ct);
    Ok(out)
}

fn open(a: &Account, device: &str, segment: &str, blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < 24 {
        return Err("块太短".into());
    }
    let aad = format!("{device}/{segment}");
    let packed = a
        .cipher()
        .decrypt(XNonce::from_slice(&blob[..24]), Payload { msg: &blob[24..], aad: aad.as_bytes() })
        .map_err(|_| "解密失败：密钥不对，或块被改过")?;
    miniz_oxide::inflate::decompress_to_vec_with_limit(&packed, 512 * 1024 * 1024).map_err(|_| "解压失败".to_string())
}

// ---------- 状态 ----------

fn state_path(root: &Path) -> PathBuf {
    root.join("sync").join("state.json")
}

#[derive(Default)]
struct State {
    /// "设备/分段" → [大小, 修改时间秒]
    up: BTreeMap<String, (u64, u64)>,
    /// 下载游标：服务器上的更新时刻（毫秒）
    since: i64,
    /// 同步来的设备（不上传）
    remote: BTreeSet<String>,
    raw: Map<String, Value>,
}

fn read_state(root: &Path) -> State {
    let raw: Map<String, Value> = fs::read_to_string(state_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let up = raw
        .get("up")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), (v.get(0)?.as_u64()?, v.get(1)?.as_u64()?)))).collect())
        .unwrap_or_default();
    let remote = raw.get("remote").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    State { up, since: raw.get("since").and_then(Value::as_i64).unwrap_or(0), remote, raw }
}

fn write_state(root: &Path, s: &State) {
    let mut raw = s.raw.clone();
    raw.insert("up".into(), Value::Object(s.up.iter().map(|(k, (a, b))| (k.clone(), json!([a, b]))).collect()));
    raw.insert("since".into(), json!(s.since));
    raw.insert("remote".into(), json!(s.remote));
    let _ = fs::create_dir_all(root.join("sync"));
    let tmp = root.join("sync").join("state.json.tmp");
    if fs::write(&tmp, serde_json::to_vec_pretty(&Value::Object(raw)).unwrap_or_default()).is_ok() {
        let _ = fs::rename(tmp, state_path(root));
    }
}

/// 给页面看的同步状态
pub fn status(root: &Path) -> Value {
    let a = load(root);
    let s = read_state(root);
    json!({
        "configured": a.is_some(),
        "email": a.as_ref().and_then(|a| a.email.clone()),
        "server": a.as_ref().map(|a| a.server.clone()),
        "user": a.as_ref().map(|a| a.user.clone()),
        "last": s.raw.get("last"),
        "last_error": s.raw.get("last_error"),
        "uploaded": s.up.len(),
        "need_login": s.raw.get("need_login").and_then(Value::as_bool).unwrap_or(false),
        "remote_devices": remote_set(root),
        "progress": progress(),
    })
}

/// 哪些设备是同步来的（设备页标「经同步」）：状态里记的，加上目录里有 .synced 标记的
pub fn remote_set(root: &Path) -> BTreeSet<String> {
    let mut s = read_state(root).remote;
    if let Ok(it) = fs::read_dir(root.join("devices")) {
        for e in it.flatten() {
            if e.path().join(SYNCED).is_file() {
                s.insert(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    s
}

const SYNCED: &str = ".synced";
/// 设备改名的块名和本机文件名
const NAMES: &str = "names.json";
const NAMES_FILE: &str = "device_names.json";

fn read_names(p: &Path) -> Map<String, Value> {
    fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// 各设备的自定义名字（所有设备上改过的，按改名时刻取最新；改回空＝用默认名，不出现在这里）
pub fn device_names(root: &Path) -> BTreeMap<String, String> {
    let mut best: BTreeMap<String, (i64, String)> = BTreeMap::new();
    let mut files = vec![root.join(NAMES_FILE)];
    if let Ok(it) = fs::read_dir(root.join("devices")) {
        files.extend(it.flatten().map(|e| e.path().join(NAMES_FILE)));
    }
    for f in files {
        for (id, v) in read_names(&f) {
            let at = v["at"].as_i64().unwrap_or(0);
            if best.get(&id).map(|b| at > b.0).unwrap_or(true) {
                best.insert(id, (at, v["name"].as_str().unwrap_or("").to_string()));
            }
        }
    }
    best.into_iter().filter(|(_, (_, n))| !n.is_empty()).map(|(id, (_, n))| (id, n)).collect()
}

/// 给一台设备改名（空＝改回默认名）。写在本机的改名表里，下一轮同步给别的设备
pub fn rename_device(root: &Path, id: &str, name: &str) -> Result<(), String> {
    let name: String = name.trim().chars().take(40).collect();
    let f = root.join(NAMES_FILE);
    let mut m = read_names(&f);
    m.insert(id.to_string(), json!({"name": name, "at": chrono::Utc::now().timestamp_millis()}));
    fs::write(&f, serde_json::to_vec_pretty(&Value::Object(m)).unwrap_or_default()).map_err(|e| e.to_string())
}
/// 摘要块名的前缀（分段名都以年份开头，不会撞）
const SUM: &str = "sum.";

fn is_remote(root: &Path, st: &State, d: &str) -> bool {
    st.remote.contains(d) || root.join("devices").join(d).join(SYNCED).is_file()
}

// ---------- 一轮同步 ----------

pub struct Report {
    pub uploaded: usize,
    pub downloaded: usize,
    pub errors: Vec<String>,
}

fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// 一轮：先上传本机写的分段里变了的，再下载别的设备新传的。没开同步返回 None
// ---------- 这一轮进行到哪（设备页显示进度） ----------

static PHASE: Mutex<&'static str> = Mutex::new("");
static DONE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);

fn set_phase(phase: &'static str, total: usize) {
    *PHASE.lock().unwrap() = phase;
    DONE.store(0, Ordering::Relaxed);
    TOTAL.store(total, Ordering::Relaxed);
}

/// {phase: "upload"／"download"／""（没在同步）, done, total}
pub fn progress() -> Value {
    json!({"phase": *PHASE.lock().unwrap(), "done": DONE.load(Ordering::Relaxed), "total": TOTAL.load(Ordering::Relaxed)})
}

pub fn sync_once(root: &Path, local_device: &str) -> Option<Report> {
    let r = sync_round(root, local_device, true);
    set_phase("", 0);
    r
}

/// 只下载（手机）：手机自己不采集电脑那种分段，也不能把它算出的东西当成某台设备的分段传上去盖掉原来的
pub fn sync_download_only(root: &Path, local_device: &str) -> Option<Report> {
    let r = sync_round(root, local_device, false);
    set_phase("", 0);
    r
}

fn sync_round(root: &Path, local_device: &str, upload: bool) -> Option<Report> {
    let a = load(root)?;
    let mut st = read_state(root);
    let mut errors = vec![];

    // 1. 上传：本机设备＋本机读到的 iPhone（同步来的不传）
    let mut todo: Vec<(String, String, PathBuf, (u64, u64))> = vec![];
    let devs = fs::read_dir(root.join("devices")).map(|r| r.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default();
    for dev in devs {
        let d = dev.file_name().to_string_lossy().to_string();
        let mine = d == local_device || (beayy_core::is_phone(&d) && !is_remote(root, &st, &d));
        if !upload || !mine || !safe_name(&d) || !dev.path().is_dir() {
            continue;
        }
        let segs = fs::read_dir(dev.path().join("segments")).map(|r| r.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default();
        for seg in segs {
            let name = seg.file_name().to_string_lossy().to_string();
            let f = seg.path().join("events.jsonl");
            let Ok(meta) = fs::metadata(&f) else { continue };
            if !safe_name(&name) {
                continue;
            }
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let sig = (meta.len(), mtime);
            if st.up.get(&format!("{d}/{name}")) != Some(&sig) {
                todo.push((d.clone(), name, f, sig));
            }
        }
    }
    // 本机写的 10 分钟摘要（<数据根>/summaries/），块名 sum.<文件名>
    for f in fs::read_dir(root.join("summaries")).ok().filter(|_| upload).map(|r| r.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default() {
        let file = f.file_name().to_string_lossy().to_string();
        let name = format!("{SUM}{file}");
        if !file.ends_with("-memory-summary.md") || !safe_name(&name) {
            continue;
        }
        let Ok(meta) = f.metadata() else { continue };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        let sig = (meta.len(), mtime);
        if st.up.get(&format!("{local_device}/{name}")) != Some(&sig) {
            todo.push((local_device.to_string(), name, f.path(), sig));
        }
    }
    // 本机的设备改名表
    if let Some(meta) = fs::metadata(root.join(NAMES_FILE)).ok().filter(|_| upload) {
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        let sig = (meta.len(), mtime);
        if st.up.get(&format!("{local_device}/{NAMES}")) != Some(&sig) {
            todo.push((local_device.to_string(), NAMES.to_string(), root.join(NAMES_FILE), sig));
        }
    }
    todo.sort_by(|x, y| (&x.0, &x.1).cmp(&(&y.0, &y.1)));
    set_phase("upload", todo.len());
    let ag = agent();
    let mut uploaded = 0;
    // 每 200 段记一次进度：传到一半退出，下次接着传
    for batch in todo.chunks(200) {
        let results: Vec<(String, Result<(u64, u64), String>)> = std::thread::scope(|s| {
            let chunks: Vec<Vec<&(String, String, PathBuf, (u64, u64))>> = (0..PARALLEL).map(|i| batch.iter().skip(i).step_by(PARALLEL).collect()).collect();
            let hs: Vec<_> = chunks
                .into_iter()
                .map(|chunk| {
                    let (a, ag) = (&a, &ag);
                    s.spawn(move || {
                        chunk
                            .into_iter()
                            .map(|(d, n, f, sig)| {
                                let r = (|| {
                                    let plain = fs::read(f).map_err(|e| e.to_string())?;
                                    let blob = seal(a, d, n, &plain)?;
                                    let resp = ag
                                        .put(&format!("{}/v1/blob/{d}/{n}", a.server))
                                        .header("Authorization", &a.auth())
                                        .header("Content-Type", "application/octet-stream")
                                        .send(&blob[..])
                                        .map_err(|e| e.to_string())?;
                                    if !resp.status().is_success() {
                                        return Err(err_of(resp));
                                    }
                                    Ok(*sig)
                                })();
                                DONE.fetch_add(1, Ordering::Relaxed);
                                (format!("{d}/{n}"), r)
                            })
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            hs.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        for (k, r) in results {
            match r {
                Ok(sig) => {
                    st.up.insert(k, sig);
                    uploaded += 1;
                }
                Err(e) => {
                    if errors.len() < 5 {
                        errors.push(format!("上传 {k}：{e}"));
                    }
                }
            }
        }
        // 中途出错也把已经传上去的记下来
        st.raw.insert("user".into(), json!(a.user));
        write_state(root, &st);
    }

    // 2. 下载：别的设备新传的
    let mut downloaded = 0;
    loop {
        let r = match ag.get(&format!("{}/v1/list?since={}", a.server, st.since)).header("Authorization", &a.auth()).call() {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                errors.push(format!("取更新列表：{}", err_of(r)));
                break;
            }
            Err(e) => {
                errors.push(format!("取更新列表：{e}"));
                break;
            }
        };
        let mut r = r;
        let v: Value = r.body_mut().read_json().unwrap_or(Value::Null);
        let items = v["items"].as_array().cloned().unwrap_or_default();
        let full = items.len() >= 5000;
        // 要下载的：别的设备的（本机电脑和本机读到的 iPhone 是自己传的）
        let wanted = |it: &Value| {
            let (d, n) = (it["device"].as_str().unwrap_or(""), it["segment"].as_str().unwrap_or(""));
            if is_special(d, n) {
                return false;
            }
            let mine = d == local_device || (beayy_core::is_phone(d) && root.join("devices").join(d).exists() && !is_remote(root, &st, d));
            !mine && safe_name(d) && safe_name(n)
        };
        let want: Vec<bool> = items.iter().map(wanted).collect();
        set_phase("download", want.iter().filter(|w| **w).count());
        // 64 段一批：8 路并行下载、解密，再按顺序写盘、推进游标（遇到失败停在那一段，下一轮从那里接着下），每批记一次进度
        let rows: Vec<(&Value, bool)> = items.iter().zip(want).collect();
        for batch in rows.chunks(64) {
            let fetched: Vec<Option<Result<Vec<u8>, String>>> = std::thread::scope(|s| {
                let lanes: Vec<_> = (0..PARALLEL_DOWN)
                    .map(|lane| {
                        let (a, ag) = (&a, &ag);
                        s.spawn(move || {
                            batch
                                .iter()
                                .enumerate()
                                .skip(lane)
                                .step_by(PARALLEL_DOWN)
                                .map(|(i, (it, want))| {
                                    let (d, n) = (it["device"].as_str().unwrap_or(""), it["segment"].as_str().unwrap_or(""));
                                    let r = want.then(|| fetch(a, ag, d, n));
                                    if r.as_ref().map(|x| x.is_ok()).unwrap_or(false) {
                                        DONE.fetch_add(1, Ordering::Relaxed);
                                    }
                                    (i, r)
                                })
                                .collect::<Vec<_>>()
                        })
                    })
                    .collect();
                let mut out: Vec<Option<Result<Vec<u8>, String>>> = (0..batch.len()).map(|_| None).collect();
                for h in lanes {
                    for (i, r) in h.join().unwrap_or_default() {
                        out[i] = r;
                    }
                }
                out
            });
            // 游标只推进到「这一批全部成功处理完」的位置。
            //
            // 原来是在每个 item 之后无条件推进 since，即使那一项是「不要的」（不是我的设备、
            // 或者 is_special 的录音块）。那样有个隐患：某台设备当时不归我（比如还没登录、
            // 或者目录还没建成），它的条目被跳过但游标推过去了，之后这台设备变成「我的」
            // 也再拉不回来——因为 since 已经越过它。宁可慢一点，也别丢数据。
            let mut batch_max = st.since;
            for ((it, want), got) in batch.iter().zip(fetched) {
                let (d, n) = (it["device"].as_str().unwrap_or(""), it["segment"].as_str().unwrap_or(""));
                if let Some(got) = got {
                    match got.and_then(|plain| store(root, d, n, plain)) {
                        Ok(_) => {
                            st.remote.insert(d.to_string());
                            downloaded += 1;
                        }
                        Err(e) => {
                            if errors.len() < 10 {
                                errors.push(format!("下载 {d}/{n}：{e}"));
                            }
                            // 这一批不推游标就退出：下次从这一批的开头重来
                            write_state(root, &st);
                            return Some(finish(root, st, uploaded, downloaded, errors));
                        }
                    }
                } else if *want {
                    // 要的、却没拿到（并行任务那里没给值）：这是异常，别越过它——
                    // 不推游标就退出，下次重来。宁可重复下载，也不能悄悄丢数据。
                    if errors.len() < 10 {
                        errors.push(format!("下载 {d}/{n}：没拿到内容，下次重试"));
                    }
                    write_state(root, &st);
                    return Some(finish(root, st, uploaded, downloaded, errors));
                }
                // 走到这里：要么成功存下了，要么本来就不要（别人的设备、录音块）。
                // 这两种都算「处理过了」，可以越过去。
                batch_max = batch_max.max(it["updated"].as_i64().unwrap_or(0));
            }
            st.since = batch_max;
            write_state(root, &st);
        }
        if !full {
            break;
        }
    }
    Some(finish(root, st, uploaded, downloaded, errors))
}

// ---------- 录音、转写、停留点、配置这些块（方案见 报告/方案_20261021_录音与存储.md）：普通同步跳过，由 beayy-remote 单独处理 ----------

/// 不是分段、摘要、改名表的块：录音 audio.、转写 transcript.、停留点 places.，以及 account 设备下的配置和声纹
pub fn is_special(device: &str, name: &str) -> bool {
    device == "account" || ["audio.", "transcript.", "places."].iter().any(|p| name.starts_with(p))
}

fn logged_in(root: &Path) -> Result<Account, String> {
    load(root).ok_or_else(|| "没登录账号".to_string())
}

/// 加密后传一块
pub fn put_named(root: &Path, device: &str, name: &str, plain: &[u8]) -> Result<(), String> {
    let a = logged_in(root)?;
    if !safe_name(device) || !safe_name(name) {
        return Err(format!("块名不合法：{device}/{name}"));
    }
    let blob = seal(&a, device, name, plain)?;
    let r = agent()
        .put(&format!("{}/v1/blob/{device}/{name}", a.server))
        .header("Authorization", &a.auth())
        .header("Content-Type", "application/octet-stream")
        .send(&blob[..])
        .map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    Ok(())
}

/// 取一块并解开；服务器上没有返回 None
pub fn get_named(root: &Path, device: &str, name: &str) -> Result<Option<Vec<u8>>, String> {
    let a = logged_in(root)?;
    let mut r = agent().get(&format!("{}/v1/blob/{device}/{name}", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if r.status().as_u16() == 404 {
        return Ok(None);
    }
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    let blob = r.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
    open(&a, device, name, &blob).map(Some)
}

pub fn delete_named(root: &Path, device: &str, name: &str) -> Result<(), String> {
    let a = logged_in(root)?;
    let r = agent().delete(&format!("{}/v1/blob/{device}/{name}", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    Ok(())
}

/// 按块名前缀列（[{device, segment, size, updated}]，按 updated 升序），since 之后的；自动翻页
pub fn list_named(root: &Path, prefix: &str, since: i64) -> Result<Vec<Value>, String> {
    let a = logged_in(root)?;
    let ag = agent();
    let (mut out, mut since) = (vec![], since);
    loop {
        let mut r = ag.get(&format!("{}/v1/list?since={since}&prefix={}", a.server, url_escape(prefix))).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
        if !r.status().is_success() {
            return Err(err_of(r));
        }
        let v: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
        let items = v["items"].as_array().cloned().unwrap_or_default();
        let full = items.len() >= 5000;
        since = items.last().and_then(|x| x["updated"].as_i64()).unwrap_or(since);
        out.extend(items);
        if !full {
            return Ok(out);
        }
    }
}

/// 服务器上这个账号存了什么：{items: [{device, kind, count, bytes, oldest, newest}], audio_max_days}
pub fn usage(root: &Path) -> Result<Value, String> {
    let a = logged_in(root)?;
    let mut r = agent().get(&format!("{}/v1/usage", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    r.body_mut().read_json().map_err(|e| e.to_string())
}

/// 官方服务（模型、地图）用的：同步服务器地址和这台设备的认证头。没登录返回 None；令牌只在 Rust 里用，不给网页
pub fn official_auth(root: &Path) -> Option<(String, String)> {
    load(root).map(|a| (a.server.clone(), a.auth()))
}

/// 官方模型的代理地址和认证头（同步服务 /v2/llm/chat/completions，按账号开通）。没登录返回 None；令牌只在 Rust 里用，不给网页
pub fn official_llm(root: &Path) -> Option<(String, String)> {
    load(root).map(|a| (format!("{}/v2/llm/chat/completions", a.server), a.auth()))
}

/// 转写票据（1 小时有效）：(票据, 到期毫秒)
pub fn ticket(root: &Path) -> Result<(String, i64), String> {
    ticket_for(root, "asr")
}

/// 官方服务的票据（1 小时有效）：kind＝asr（转写）或 map（地图），同步服务按那一项的开通和额度发
pub fn ticket_for(root: &Path, kind: &str) -> Result<(String, i64), String> {
    let a = logged_in(root)?;
    let mut r = agent().get(&format!("{}/v2/ticket?for={kind}", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(err_of(r));
    }
    let v: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
    Ok((v["ticket"].as_str().ok_or("服务器没给票据")?.to_string(), v["expires"].as_i64().unwrap_or(0)))
}

/// 取一块密文并解开
fn fetch(a: &Account, ag: &ureq::Agent, d: &str, n: &str) -> Result<Vec<u8>, String> {
    let mut resp = ag.get(&format!("{}/v1/blob/{d}/{n}", a.server)).header("Authorization", &a.auth()).call().map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(err_of(resp));
    }
    let blob = resp.body_mut().with_config().limit(64 * 1024 * 1024).read_to_vec().map_err(|e| e.to_string())?;
    open(a, d, n, &blob)
}

/// 下载来的块写到和本机写的同样的位置：分段 → devices/<设备>/segments/<分段>/events.jsonl，摘要 → devices/<设备>/summaries/<文件名>
fn store(root: &Path, d: &str, n: &str, plain: Vec<u8>) -> Result<(), String> {
    let dev = root.join("devices").join(d);
    fs::create_dir_all(&dev).map_err(|e| e.to_string())?;
    let _ = fs::write(dev.join(SYNCED), "");
    if n == NAMES {
        return fs::write(dev.join(NAMES_FILE), plain).map_err(|e| e.to_string());
    }
    if let Some(file) = n.strip_prefix(SUM) {
        // 同一分段重写过的摘要只留最新的（文件名前 19 位是分段开始时刻）
        let dir = dev.join("summaries");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if file.len() >= 19 {
            for old in fs::read_dir(&dir).map(|r| r.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default() {
                let o = old.file_name().to_string_lossy().to_string();
                if o != file && o.get(..19) == file.get(..19) {
                    let _ = fs::remove_file(old.path());
                }
            }
        }
        return fs::write(dir.join(file), plain).map_err(|e| e.to_string());
    }
    let dir = dev.join("segments").join(n);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("events.jsonl"), plain).map_err(|e| e.to_string())
}

fn finish(root: &Path, mut st: State, uploaded: usize, downloaded: usize, errors: Vec<String>) -> Report {
    if let Some(a) = load(root) {
        st.raw.insert("user".into(), json!(a.user));
    }
    st.raw.insert("last".into(), json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)));
    st.raw.insert("last_error".into(), if errors.is_empty() { Value::Null } else { json!(errors.join("；")) });
    // 令牌被注销（别的设备用恢复码重设、或在设备列表里移除了这台）：要重新登录
    st.raw.insert("need_login".into(), json!(errors.iter().any(|e| e.contains("401"))));
    write_state(root, &st);
    Report { uploaded, downloaded, errors }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip() {
        let a = Account { server: "x".into(), user: "u".into(), email: None, token: "t".into(), key: [7; 32] };
        let blob = seal(&a, "mac-a", "2026-10-16T01-00-00Z", b"hello\n").unwrap();
        assert_eq!(open(&a, "mac-a", "2026-10-16T01-00-00Z", &blob).unwrap(), b"hello\n");
        // 挪到别的分段解不开
        assert!(open(&a, "mac-a", "2026-10-16T01-10-00Z", &blob).is_err());
        // 配对码来回
        let b = Account::from_code(&a.code()).unwrap();
        assert_eq!((b.user, b.token, b.key), (a.user, a.token, a.key));
        // 恢复码来回
        let key = [0xA5u8; 32];
        assert_eq!(parse_recovery(&recovery_code_of(&key).to_lowercase()).unwrap(), key);
        // 包一层再解开；包钥不对解不开
        let w = wrap_key(&key, &[1; 32]).unwrap();
        assert_eq!(unwrap_key(&w, &[1; 32]).unwrap(), key);
        assert!(unwrap_key(&w, &[2; 32]).is_err());
    }

    /// 给别的端（iPhone 的 Swift）对照的测试向量：cargo test -p beayy-sync vectors -- --nocapture
    #[test]
    fn vectors() {
        let (auth, wrap) = derive("correct horse battery", "00112233445566778899aabbccddeeff").unwrap();
        let key = [0x42u8; 32];
        let nonce = [9u8; 24];
        let wrapped = {
            let ct = XChaCha20Poly1305::new((&wrap).into()).encrypt(XNonce::from_slice(&nonce), Payload { msg: &key[..], aad: b"beayy-data-key" }).unwrap();
            B64.encode([nonce.to_vec(), ct].concat())
        };
        assert_eq!(unwrap_key(&wrapped, &wrap).unwrap(), key);
        let a = Account { server: "x".into(), user: "u".into(), email: None, token: "t".into(), key };
        let plain = b"{\"id\":\"watch-20261021T010000Z\"}\nhello";
        let packed = miniz_oxide::deflate::compress_to_vec(plain, 6);
        let ct = a.cipher().encrypt(XNonce::from_slice(&nonce), Payload { msg: &packed, aad: b"watch-1a2b3c4d/audio.watch-20261021T010000Z" }).unwrap();
        let blob = [nonce.to_vec(), ct].concat();
        assert_eq!(open(&a, "watch-1a2b3c4d", "audio.watch-20261021T010000Z", &blob).unwrap(), plain);
        println!("password=correct horse battery salt=00112233445566778899aabbccddeeff");
        println!("auth={auth}");
        println!("wrap={}", hex_encode(&wrap));
        println!("data_key={}", hex_encode(&key));
        println!("wrapped_key(b64url nopad, nonce 0909..)={wrapped}");
        println!("blob device=watch-1a2b3c4d name=audio.watch-20261021T010000Z hex={}", hex_encode(&blob));
        println!("blob plaintext={}", String::from_utf8_lossy(plain));
    }
}
