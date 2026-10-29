//! 模型配置（和账号同步、和本机密钥分开）。
//!
//! 三样东西要分清：
//! - **本机私密**：API Key。只在钥匙串（macOS）或数据目录里的文件（其它系统），**永远不上传**。
//! - **跨设备同步**：网关地址、模型名、模式（官方／自己的）。走 `account/model.json` 加密块，别的设备登录后自动拉下来。
//! - **账号额度**：官方模型按月 token、转写分钟、地图次数，只有登录且开通了才有，按需查服务器。
//!
//! 为什么密钥不同步：这个项目对用户的核心承诺是「服务器读不到内容」。把密钥传上去等于把钱袋子交出去，
//! 也会让「服务器只存密文」这条边界失去意义。所以同步结构里**在类型层面就没有密钥字段**，
//! 并且 `from_json` 显式丢弃任何形如 key 的键——就算哪天上游误传也不会落盘。

use serde_json::{json, Map, Value};

/// 模型配置里可跨设备同步的部分（**不含密钥**）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelProfile {
    /// "official"（用账号开通的官方服务）或 "custom"（自己的 OpenAI 兼容网关）
    pub mode: String,
    /// OpenAI 兼容地址，如 https://api.openai.com/v1
    pub gateway: String,
    /// 10 分钟摘要用的模型
    pub model_segment: String,
    /// 日总结／周总结用的模型；空＝跟 model_segment 一致
    pub model_daily: String,
    /// 毫秒时间戳：合并时取新的那份
    pub updated: i64,
}

impl Default for ModelProfile {
    fn default() -> Self {
        ModelProfile {
            mode: "official".into(),
            gateway: super::DEFAULT_GATEWAY.to_string(),
            model_segment: super::DEFAULT_MODEL.to_string(),
            model_daily: String::new(),
            updated: 0,
        }
    }
}

/// 同步块的名字（`account` 设备下）；和 beayy-remote 的 `config.json` 并列
pub const SYNC_BLOCK: &str = "model.json";

/// 看起来像密钥的键名：任何带 key／secret／token／password 的都不要
fn looks_secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["key", "secret", "token", "password", "passwd", "credential", "bearer"]
        .iter()
        .any(|w| k.contains(w))
}

impl ModelProfile {
    /// 日总结实际用哪个模型：没单独填就跟摘要那个
    pub fn daily_or_segment(&self) -> &str {
        if self.model_daily.trim().is_empty() {
            &self.model_segment
        } else {
            &self.model_daily
        }
    }

    /// 能不能拿来跑摘要：自定义模式要有网关和模型；官方模式只要模型名（地址走同步服务）
    pub fn problems(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.mode == "custom" && self.gateway.trim().is_empty() {
            out.push("gateway");
        }
        if self.model_segment.trim().is_empty() {
            out.push("model");
        }
        out
    }

    pub fn ready(&self) -> bool {
        self.problems().is_empty()
    }

    /// 写进同步块：字段白名单，**没有密钥字段**
    pub fn to_json(&self) -> Value {
        json!({
            "mode": self.mode,
            "gateway": self.gateway,
            "model_segment": self.model_segment,
            "model_daily": self.model_daily,
            "updated": self.updated,
        })
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(&self.to_json()).unwrap_or_default()
    }

    /// 从同步块读回来。认不出的字段一律丢掉；带密钥意味的键直接跳过（防御性，正常不会出现）
    pub fn from_json(v: &Value) -> ModelProfile {
        let d = ModelProfile::default();
        let str_of = |k: &str, fallback: &str| -> String {
            if looks_secret(k) {
                return fallback.to_string();
            }
            v.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).unwrap_or(fallback).to_string()
        };
        let mode = {
            let m = str_of("mode", &d.mode);
            if m == "custom" { "custom".to_string() } else { "official".to_string() }
        };
        ModelProfile {
            mode,
            gateway: str_of("gateway", &d.gateway),
            model_segment: str_of("model_segment", &d.model_segment),
            model_daily: v.get("model_daily").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string(),
            updated: v.get("updated").and_then(Value::as_i64).unwrap_or(0),
        }
    }

    pub fn from_bytes(b: &[u8]) -> Option<ModelProfile> {
        serde_json::from_slice::<Value>(b).ok().map(|v| ModelProfile::from_json(&v))
    }

    /// 从「本机设置」这份原始 JSON（settings.json 的字段名）里取
    pub fn from_settings(s: &Map<String, Value>) -> ModelProfile {
        let get = |k: &str| s.get(k).and_then(Value::as_str).map(str::trim).filter(|x| !x.is_empty()).map(String::from);
        ModelProfile {
            mode: get("model_mode").unwrap_or_else(|| "official".into()),
            gateway: get("gateway").unwrap_or_else(|| super::DEFAULT_GATEWAY.to_string()),
            model_segment: get("summary_model").unwrap_or_else(|| super::DEFAULT_MODEL.to_string()),
            model_daily: get("daily_model").unwrap_or_default(),
            updated: s.get("model_updated").and_then(Value::as_i64).unwrap_or(0),
        }
    }

    /// 写回设置（只动这几个键，别的不碰）
    pub fn write_into(&self, s: &mut Map<String, Value>) {
        s.insert("model_mode".into(), json!(self.mode));
        s.insert("gateway".into(), json!(self.gateway));
        s.insert("summary_model".into(), json!(self.model_segment));
        s.insert("daily_model".into(), json!(self.model_daily));
        s.insert("model_updated".into(), json!(self.updated));
    }

    /// 两台设备各自的配置：取 `updated` 新的那份。一样新就用本机的。
    /// 返回 (要采用的配置, 要不要往服务器推)
    pub fn merge(local: &ModelProfile, remote: &ModelProfile) -> (ModelProfile, bool) {
        if remote.updated > local.updated {
            // 远端更新：落地，不用回推
            (remote.clone(), false)
        } else if local.updated > remote.updated {
            // 本机更新：推上去
            (local.clone(), true)
        } else {
            (local.clone(), false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(mode: &str, gw: &str, seg: &str, updated: i64) -> ModelProfile {
        ModelProfile { mode: mode.into(), gateway: gw.into(), model_segment: seg.into(), model_daily: String::new(), updated }
    }

    #[test]
    fn roundtrip_keeps_everything_but_secrets() {
        let a = ModelProfile {
            mode: "custom".into(),
            gateway: "https://api.example.com/v1".into(),
            model_segment: "gpt-4o-mini".into(),
            model_daily: "gpt-4o".into(),
            updated: 1700000000000,
        };
        let b = ModelProfile::from_json(&a.to_json());
        assert_eq!(a, b);
    }

    /// 硬约束：同步结构里不可能出现密钥
    #[test]
    fn never_carries_api_key() {
        let a = p("custom", "https://api.example.com/v1", "m", 1);
        let j = a.to_json();
        let obj = j.as_object().unwrap();
        for k in obj.keys() {
            let lk = k.to_ascii_lowercase();
            assert!(!lk.contains("key") && !lk.contains("token") && !lk.contains("secret"), "同步结构里出现了密钥字段：{k}");
        }
        // 就算有人把密钥塞进同步块，读回来也不会保留
        let dirty = json!({
            "mode": "custom", "gateway": "g", "model_segment": "m", "updated": 5,
            "api_key": "sk-should-not-survive", "token": "t", "secret": "s"
        });
        let got = ModelProfile::from_json(&dirty);
        let text = serde_json::to_string(&got.to_json()).unwrap();
        assert!(!text.contains("sk-should-not-survive"));
        assert!(!text.contains('t') || !text.contains("\"token\""));
        assert!(got.to_json().get("api_key").is_none());
    }

    #[test]
    fn merge_takes_newer() {
        let local = p("custom", "g1", "m1", 100);
        let remote = p("custom", "g2", "m2", 200);
        let (got, push) = ModelProfile::merge(&local, &remote);
        assert_eq!(got.gateway, "g2");
        assert!(!push, "远端更新时只落地，不回推");

        let (got, push) = ModelProfile::merge(&remote, &local);
        assert_eq!(got.gateway, "g2");
        assert!(push, "本机更新时要推上去");

        let (got, push) = ModelProfile::merge(&local, &local);
        assert_eq!(got.gateway, "g1");
        assert!(!push, "一样新时不动");
    }

    #[test]
    fn readiness() {
        // 官方模式：地址走同步服务，只要有模型名
        let mut a = p("official", "", "gpt-4o-mini", 1);
        assert!(a.ready());
        a.model_segment = String::new();
        assert!(!a.ready());
        assert_eq!(a.problems(), vec!["model"]);

        // 自定义模式：网关和模型都要
        let mut c = p("custom", "", "m", 1);
        assert!(!c.ready());
        assert_eq!(c.problems(), vec!["gateway"]);
        c.gateway = "https://x/v1".into();
        assert!(c.ready());

        // 日总结没单独填就跟摘要那个
        let d = p("custom", "g", "seg-model", 1);
        assert_eq!(d.daily_or_segment(), "seg-model");
    }

    #[test]
    fn settings_roundtrip() {
        let mut s = Map::new();
        let a = p("custom", "https://api.x/v1", "m-seg", 4242);
        a.write_into(&mut s);
        assert_eq!(ModelProfile::from_settings(&s), a);
        assert_eq!(s["summary_model"], json!("m-seg"));
        assert!(s.get("api_key").is_none(), "写设置时不该凭空造出密钥字段");
    }
}
