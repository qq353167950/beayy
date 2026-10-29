//! 设置「数据」页：数据存在哪三个地方（本机、同步服务、转写服务），各存了什么、多大、留多久。
//! 方案见 报告/方案_20261021_录音与存储.md。网页开着这一页时每分钟取一次。

use beayy_core::{data_root, default_root};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

fn dir_size(p: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(p) else { return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0) };
    rd.filter_map(|e| e.ok())
        .map(|e| if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { dir_size(&e.path()) } else { e.metadata().map(|m| m.len()).unwrap_or(0) })
        .sum()
}

/// 本机：按用途分几类
fn local(root: &Path) -> Value {
    let mut cats: BTreeMap<&str, u64> = BTreeMap::new();
    for e in std::fs::read_dir(root.join("devices")).map(|r| r.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default() {
        let n = e.file_name().to_string_lossy().to_string();
        let k = beayy_core::device_kind(&n);
        *cats.entry(k).or_default() += dir_size(&e.path());
    }
    let total = dir_size(root);
    let summaries = dir_size(&root.join("summaries"));
    let places = dir_size(&root.join("places"));
    let known: u64 = cats.values().sum::<u64>() + summaries + places;
    let row = |key: &str, name: &str, bytes: u64, keep: &str| json!({"key": key, "name": name, "bytes": bytes, "keep": keep});
    json!({
        "path": root.to_string_lossy(),
        "total": total,
        "items": [
            row("computer", "电脑记录", *cats.get("computer").unwrap_or(&0), "长期"),
            row("summaries", "10 分钟摘要", summaries, "长期"),
            row("phone", "手机使用和停留点", *cats.get("phone").unwrap_or(&0), "长期"),
            row("watch", "对话转写", *cats.get("watch").unwrap_or(&0), "长期"),
            row("places", "地点缓存", places, "长期"),
            row("other", "其他", total.saturating_sub(known), "长期"),
        ],
    })
}

/// 同步服务（官方的在 hk2，2026-10-29 从 Cloudflare 搬过去）：按种类合计
fn cloud(root: &Path) -> Value {
    if beayy_sync::load(root).is_none() {
        return json!({"error": "没登录账号，没有存到同步服务"});
    }
    let u = match beayy_sync::usage(root) {
        Ok(u) => u,
        Err(e) => return json!({"error": e}),
    };
    let max_days = u["audio_max_days"].as_i64().unwrap_or(30);
    let mut kinds: BTreeMap<String, (u64, u64, i64)> = BTreeMap::new();
    for it in u["items"].as_array().cloned().unwrap_or_default() {
        let e = kinds.entry(it["kind"].as_str().unwrap_or("").to_string()).or_insert((0, 0, i64::MAX));
        e.0 += it["count"].as_u64().unwrap_or(0);
        e.1 += it["bytes"].as_u64().unwrap_or(0);
        e.2 = e.2.min(it["oldest"].as_i64().unwrap_or(i64::MAX));
    }
    let keep_audio = format!("转写完 {} 天后删，没转的最多 {max_days} 天", beayy_remote::cloud::AUDIO_KEEP_DAYS);
    let names = [
        ("segment", "电脑和手机记录", "长期"),
        ("summary", "10 分钟摘要", "长期"),
        ("audio", "录音", keep_audio.as_str()),
        ("transcript", "对话转写", "长期"),
        ("places", "停留点", "长期"),
        ("account", "账号设置和声纹", "长期"),
    ];
    let items: Vec<Value> = names
        .iter()
        .map(|(k, name, keep)| {
            let (count, bytes, oldest) = kinds.get(*k).cloned().unwrap_or((0, 0, i64::MAX));
            json!({"key": k, "name": name, "count": count, "bytes": bytes, "oldest": if oldest == i64::MAX { Value::Null } else { json!(oldest) }, "keep": keep})
        })
        .collect();
    let total: u64 = kinds.values().map(|x| x.1).sum();
    json!({"server": beayy_sync::load(root).map(|a| a.server).unwrap_or_default(), "total": total, "items": items})
}

/// 转写服务：这个账号排队、在转的任务
fn transcribe(root: &Path) -> Value {
    let server = beayy_remote::cloud::transcribe_server();
    if beayy_sync::load(root).is_none() {
        return json!({"server": server, "error": "没登录账号，转写服务认不出你"});
    }
    match beayy_remote::cloud::transcribe_usage(root) {
        Ok(v) => json!({"server": server, "jobs": v["jobs"], "bytes": v["bytes"], "keep": "音频转完就删，结果取走就删，没取走的最多 7 天"}),
        Err(e) => json!({"server": server, "error": e}),
    }
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn storage_stats() -> Value {
    let root = data_root();
    let repo = crate::data::read_settings_raw().get("repo_path").and_then(|v| v.as_str()).map(|s| s.replace('~', &std::env::var("HOME").unwrap_or_default()));
    let repo = repo.filter(|r| Path::new(r).join("raw").is_dir()).map(|r| json!({"path": r, "bytes": dir_size(&Path::new(&r).join("raw")), "keep": "长期（git 历史）"}));
    json!({
        "local": local(&root),
        "cloud": cloud(&root),
        "transcribe": transcribe(&root),
        "repo": repo,
        "default_root": default_root().to_string_lossy(),
        "at": chrono::Utc::now().timestamp_millis(),
    })
}
