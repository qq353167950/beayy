//! 日总结、周总结：app 自己用记录写，不依赖外部脚本。
//! 数字（在电脑前、手机、领域和项目、类型、规矩守没守住、去了哪、说了多少话）由代码算好填进去；模型只写一句话、做成了什么、偏离、明天。
//! 写到 Beayy/daily/日总结_YYYYMMDD.md、周总结_YYYYMMDD.md（日期取周一）。每天 21:30 写当天，次日 0:15 以后用完整的一天重写；
//! 每 10 分钟看一遍最近 7 天：缺的补上（app 没开、模型出错），数据晚到的（手机录音、屏幕使用时间隔几天才同步过来）重写；
//! 上一周过完写周总结，那周的日总结重写过就跟着重写。每次的结果记在 daily/state.json，失败按次数往后推着重试。页面上也可以随时生成。

use beayy_core::default_root;
use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Timelike, Utc};
use regex::Regex;
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

/// 日总结的写法变了就加一：已有的最近 7 天按新写法重写一遍（2：材料里加了去了哪、对话）
const VERSION: i64 = 2;

pub fn path_of(date: NaiveDate) -> PathBuf {
    default_root().join("daily").join(format!("日总结_{}.md", date.format("%Y%m%d")))
}

pub fn week_path(monday: NaiveDate) -> PathBuf {
    default_root().join("daily").join(format!("周总结_{}.md", monday.format("%Y%m%d")))
}

pub fn monday_of(date: NaiveDate) -> NaiveDate {
    date - Duration::days(date.format("%u").to_string().parse::<i64>().unwrap_or(1) - 1)
}

// ---------- 每次写的结果：daily/state.json {"days": {日期: …}, "weeks": {周一: …}} ----------

fn state_path() -> PathBuf {
    default_root().join("daily").join("state.json")
}

fn read_state() -> Value {
    fs::read_to_string(state_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| serde_json::json!({}))
}

fn note(kind: &str, key: &str, entry: Value) {
    let mut st = read_state();
    st[kind][key] = entry;
    let _ = fs::create_dir_all(state_path().parent().unwrap());
    let _ = fs::write(state_path(), serde_json::to_vec_pretty(&st).unwrap_or_default());
}

fn log_line(line: &str) {
    let logs = default_root().join("logs");
    let _ = fs::create_dir_all(&logs);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(logs.join("daily.log")) {
        let _ = writeln!(f, "{} {line}", Local::now().format("%Y-%m-%d %H:%M"));
    }
}

/// 记一次成功或失败。失败隔 30 分钟、1、2、4 小时……再试，最多 6 小时；这一天没记录的不算失败，等数据变了再试
fn record(kind: &str, key: &str, bytes: u64, r: &Result<String, String>) {
    let now = Utc::now().timestamp();
    let entry = match r {
        Ok(md) => {
            log_line(&format!("{key}：写好了（{} 字）", md.chars().count()));
            serde_json::json!({"v": VERSION, "bytes": bytes, "at": now})
        }
        Err(e) => {
            log_line(&format!("{key}：{e}"));
            let fails = read_state()[kind][key]["fails"].as_i64().unwrap_or(0) + 1;
            let empty = e.starts_with("这一天没有记录") || e.starts_with("这周还没有日总结");
            let wait = if empty { 0 } else { (1800 * (1i64 << (fails - 1).min(4))).min(6 * 3600) };
            serde_json::json!({"error": e, "fails": fails, "retry_at": now + wait, "empty": empty, "bytes": bytes, "failed_at": now})
        }
    };
    note(kind, key, entry);
}

/// 这一天各设备记下的事件有多少字节。数据晚到会让它变大，用来判断要不要重写
fn input_bytes(date: NaiveDate) -> u64 {
    let s = Local.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap()).unwrap().with_timezone(&Utc);
    let key = |t: DateTime<Utc>| t.format("%Y-%m-%dT%H-%M-00Z").to_string();
    let (lo, hi) = (key(s), key(s + Duration::days(1)));
    let mut n = 0;
    for dev in fs::read_dir(default_root().join("devices")).into_iter().flatten().flatten() {
        for seg in fs::read_dir(dev.path().join("segments")).into_iter().flatten().flatten() {
            let name = seg.file_name().to_string_lossy().to_string();
            if name >= lo && name < hi {
                n += fs::metadata(seg.path().join("events.jsonl")).map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    n
}

// ---------- 规矩：和页面上同一套识别规则 ----------

enum Rule {
    /// 几点以后不用：设备 computer／phone／any
    After { dev: &'static str, h: u32, m: u32 },
    /// 某设备每天不超过多少分钟
    Limit { dev: &'static str, minutes: f64 },
    /// 某 app 每天不超过多少分钟
    App { app: String, minutes: f64 },
}

fn parse_rule(text: &str) -> Option<Rule> {
    let t: String = text.split_whitespace().collect();
    let low = t.to_lowercase();
    let dev = if t.contains("电脑") || low.contains("mac") { "computer" } else if t.contains("手机") || low.contains("iphone") { "phone" } else { "any" };
    let after = Regex::new(r"(\d{1,2})(?:[:：点](\d{2})?)?(?:分)?(?:以后|之后|后)").unwrap();
    if let Some(c) = after.captures(&t) {
        if Regex::new(r"不|别|停|关|禁").unwrap().is_match(&t) {
            let mut h: u32 = c[1].parse().ok()?;
            if h < 12 && Regex::new(r"晚上|夜里|夜间|下午|傍晚").unwrap().is_match(&t) {
                h += 12;
            }
            return Some(Rule::After { dev, h, m: c.get(2).and_then(|x| x.as_str().parse().ok()).unwrap_or(0) });
        }
    }
    let lim = Regex::new(r"(?i)(?:不超过|少于|最多|以内|不到|≤|<=?)(\d+(?:\.\d+)?)(小时|h|分钟|min|分)").unwrap();
    if let Some(c) = lim.captures(&t) {
        let n: f64 = c[1].parse().ok()?;
        let minutes = if c[2].contains('小') || c[2].eq_ignore_ascii_case("h") { n * 60.0 } else { n };
        let subject = Regex::new(r"每天|一天|每日|不超过|少于|最多|不到").unwrap().split(&t).next().unwrap_or("").to_string();
        let subject = subject.trim_start_matches(['用', '玩', '刷', '看']).to_string();
        if dev != "any" && Regex::new(r"(?i)^(电脑|手机|mac|iphone)?$").unwrap().is_match(&subject) {
            return Some(Rule::Limit { dev, minutes });
        }
        if !subject.is_empty() {
            return Some(Rule::App { app: subject, minutes });
        }
    }
    None
}

fn secs_after(spans: &[(DateTime<Utc>, DateTime<Utc>)], from: DateTime<Utc>, to: DateTime<Utc>) -> f64 {
    spans.iter().map(|(a, b)| ((*b).min(to) - (*a).max(from)).num_milliseconds().max(0) as f64 / 1000.0).sum()
}

/// 一条规矩今天守没守住：（对照说明，是否守住；None＝还没到点或算不出）
fn check(rule: &str, date: NaiveDate, day: &Value) -> (String, Option<bool>) {
    let Some(r) = parse_rule(rule) else { return ("算不出来，看下面的偏离".into(), None) };
    let live = &day["live"];
    let phone = &day["phone"];
    let iso = |v: &Value| v.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Utc));
    let start = Local.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap()).unwrap().with_timezone(&Utc);
    let end = start + Duration::days(1);
    match r {
        Rule::After { dev, h, m } => {
            let from = start + Duration::minutes((h * 60 + m) as i64);
            if Utc::now() < from {
                return (format!("还没到 {h:02}:{m:02}"), None);
            }
            let mut sec = 0.0;
            if dev != "phone" {
                let spans: Vec<_> = live["spans"].as_array().cloned().unwrap_or_default().iter().filter_map(|x| Some((iso(&x[0])?, iso(&x[1])?))).collect();
                sec += secs_after(&spans, from, end);
            }
            if dev != "computer" {
                for x in phone["sessions"].as_array().cloned().unwrap_or_default() {
                    if let (Some(a), Some(b)) = (iso(&x["start"]), iso(&x["end"])) {
                        let span = (b - a).num_seconds().max(1) as f64;
                        sec += secs_after(&[(a, b)], from, end) / span * x["sec"].as_f64().unwrap_or(0.0);
                    }
                }
            }
            (format!("{h:02}:{m:02} 以后用了 {} 分钟", (sec / 60.0).round()), Some(sec < 60.0))
        }
        Rule::Limit { dev, minutes } => {
            let sec = if dev == "phone" { phone["total_sec"].as_f64().unwrap_or(0.0) } else { live["active_sec"].as_f64().unwrap_or(0.0) };
            (format!("{} {:.1} 小时 / 上限 {:.1} 小时", if dev == "phone" { "手机" } else { "电脑" }, sec / 3600.0, minutes / 60.0), Some(sec <= minutes * 60.0))
        }
        Rule::App { app, minutes } => {
            let key = app.to_lowercase();
            let hit = |x: &Value| x["name"].as_str().unwrap_or("").to_lowercase().contains(&key) || x["bundle_id"].as_str().unwrap_or("").to_lowercase().contains(&key);
            let mut sec = 0.0;
            for s in phone["sessions"].as_array().cloned().unwrap_or_default() {
                for a in s["apps"].as_array().cloned().unwrap_or_default() {
                    if hit(&a) {
                        sec += a["sec"].as_f64().unwrap_or(0.0);
                    }
                }
            }
            for a in live["apps"].as_array().cloned().unwrap_or_default() {
                if hit(&a) {
                    sec += a["sec"].as_f64().unwrap_or(0.0);
                }
            }
            (format!("{app} {} 分钟 / 上限 {} 分钟", (sec / 60.0).round(), minutes), Some(sec <= minutes * 60.0))
        }
    }
}

const PROMPT: &str = "你是用户的日记助手。下面是用户今天的记录：电脑和手机的时长、时间花在哪些领域和项目、每小时在做什么、自己定的规矩今天的对照结果，有的话还有去了哪（手机停留点）和对话（录音转写）。
据此写今天的日总结，全部用中文，用第二人称「你」，写得具体、平实，不夸、不说教。只写材料里有的事，不编造，不写材料里没有的数字。
去了哪、对话也算今天做的事：见了谁、谈了什么、在外面待了多久，有内容就写进去；转写有错字，意思不明的不硬猜、不逐字引用。
只返回一个 JSON 对象，不要代码块，字段：
  line: 今天的一句话，30 字以内，抓住今天最主要的事和状态
  done: 2–5 条字符串，今天做成或推进了什么（写结果，不写过程）
  drift: 0–3 条字符串，偏离：没守住的规矩、熬夜、时间明显被不重要的事占掉；没有就空数组
  tomorrow: 1–3 条字符串，明天最值得做的事，从今天没做完的里挑
";

fn dur(sec: f64) -> String {
    if sec < 3600.0 {
        format!("{} 分钟", (sec / 60.0).round())
    } else {
        format!("{:.1} 小时", sec / 3600.0)
    }
}

fn hm(v: &Value) -> String {
    v.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Local).format("%H:%M").to_string()).unwrap_or_default()
}

fn secs_between(a: &Value, b: &Value) -> f64 {
    let t = |v: &Value| v.as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok());
    match (t(a), t(b)) {
        (Some(a), Some(b)) => (b - a).num_seconds().max(0) as f64,
        _ => 0.0,
    }
}

/// 去了哪：（读数一行，给模型的逐段）。前一天到的（在家过夜）从 0 点算起
fn places_text(places: &Value, date: NaiveDate) -> Option<(String, Vec<String>)> {
    let visits = places["visits"].as_array().filter(|v| !v.is_empty())?;
    let name = |v: &Value| v["label"].as_str().or(v["name"].as_str()).filter(|x| !x.is_empty()).unwrap_or("没取到名字的地方").to_string();
    let day = Local.from_local_datetime(&date.and_hms_opt(0, 0, 0).unwrap()).unwrap();
    let clip = |v: &Value, k: &str| -> Value {
        let t = v[k].as_str().and_then(|x| DateTime::parse_from_rfc3339(x).ok()).map(|t| t.with_timezone(&Local));
        t.map(|t| serde_json::json!(t.clamp(day, day + Duration::days(1)).to_rfc3339())).unwrap_or(Value::Null)
    };
    let sec = |v: &Value| secs_between(&clip(v, "start"), &clip(v, "end"));
    let mut by: Vec<(String, f64)> = vec![];
    for v in visits {
        match by.iter_mut().find(|x| x.0 == name(v)) {
            Some(x) => x.1 += sec(v),
            None => by.push((name(v), sec(v))),
        }
    }
    by.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let top: Vec<String> = by.iter().take(5).map(|(n, s)| format!("{n} {}", dur(*s))).collect();
    let line = format!("去了 {} 个地方：{}", by.len(), top.join("、"));
    let rows = visits.iter().take(30).map(|v| format!("{}–{} {}（{}）", hm(&clip(v, "start")), hm(&clip(v, "end")), name(v), dur(sec(v)))).collect();
    Some((line, rows))
}

/// 对话：（读数一行，给模型的逐小时摘录）。一段对话可能连着好几个小时、说话人也分不准，所以按小时摘：
/// 说得多的小时先挑，最多 15 个小时、6000 字，每小时截前面一部分，再按时间排
fn speech_text(speech: &Value) -> Option<(String, Vec<String>)> {
    let convs = speech["conversations"].as_array().filter(|v| !v.is_empty())?;
    let talk = speech["talk_sec"].as_f64().unwrap_or(0.0);
    let mine: f64 = speech["speakers_sec"].as_object().map(|m| m.iter().filter(|(k, _)| !k.starts_with("他人") && *k != "未辨").filter_map(|(_, v)| v.as_f64()).sum()).unwrap_or(0.0);
    let line = format!("录到说话 {}{}", dur(talk), if mine > 0.0 { format!("，其中你 {}", dur(mine)) } else { String::new() });
    let mut hours: std::collections::BTreeMap<String, (f64, String)> = Default::default();
    for l in convs.iter().flat_map(|c| c["lines"].as_array().cloned().unwrap_or_default()) {
        let h = hm(&l["start"]).get(..2).unwrap_or("").to_string();
        let e = hours.entry(h).or_default();
        e.0 += secs_between(&l["start"], &l["end"]);
        if e.1.chars().count() < 400 {
            let who = l["speaker"].as_str().unwrap_or("");
            e.1 += &format!("{}{} ", if who.starts_with("他人") || who == "未辨" { "" } else { "【你】" }, l["text"].as_str().unwrap_or(""));
        }
    }
    let mut pick: Vec<(String, (f64, String))> = hours.into_iter().filter(|(_, (sec, _))| *sec >= 60.0).collect();
    pick.sort_by(|a, b| b.1 .0.partial_cmp(&a.1 .0).unwrap());
    pick.truncate(15);
    pick.sort_by(|a, b| a.0.cmp(&b.0));
    let rows = pick.into_iter().map(|(h, (sec, text))| format!("{h}:00 这一小时说话 {}：{}", dur(sec), text.chars().take(400).collect::<String>().trim())).collect();
    Some((line, rows))
}

/// 写某天的日总结（结果记进 state.json）；返回 Markdown
pub fn generate(date: NaiveDate) -> Result<String, String> {
    let bytes = input_bytes(date);
    let r = write_day(date);
    record("days", &date.format("%Y-%m-%d").to_string(), bytes, &r);
    r
}

fn write_day(date: NaiveDate) -> Result<String, String> {
    let mut day = crate::data::get_day(date.format("%Y-%m-%d").to_string());
    // 有外部数据包的日子 get_day 不算电脑读数（页面用数据包的），这里要用：在电脑前、规矩对照都靠它
    if day["live"].is_null() {
        day["live"] = crate::data::live_computer(date).unwrap_or(Value::Null);
    }
    let live = &day["live"];
    let phone = &day["phone"];
    let work = &day["work"];
    let places = places_text(&day["places"], date);
    let speech = speech_text(&day["speech"]);
    if live.is_null() && phone.is_null() && places.is_none() && speech.is_none() {
        return Err("这一天没有记录".into());
    }
    // 代码算的数字
    let mut stats = vec![];
    if let Some(sec) = live["active_sec"].as_f64() {
        stats.push(format!("在电脑前 {}（{}–{}），切换 app {} 次", dur(sec), live["first"].as_str().unwrap_or(""), live["last"].as_str().unwrap_or(""), live["switches"]));
    }
    if let Some(sec) = phone["total_sec"].as_f64() {
        let top: Vec<String> = phone["apps"].as_array().cloned().unwrap_or_default().iter().take(3).map(|a| format!("{} {}", a["name"].as_str().unwrap_or(""), dur(a["sec"].as_f64().unwrap_or(0.0)))).collect();
        stats.push(format!("手机 {}，拿起 {} 次{}", dur(sec), phone["pickups"], if top.is_empty() { String::new() } else { format!("，最多的是 {}", top.join("、")) }));
    }
    if let Some((line, _)) = &places {
        stats.push(line.clone());
    }
    if let Some((line, _)) = &speech {
        stats.push(line.clone());
    }
    let tree = |k: &str| -> Vec<String> {
        work[k].as_array().cloned().unwrap_or_default().iter().map(|g| {
            let kids: Vec<String> = g["children"].as_array().cloned().unwrap_or_default().iter().take(4).map(|c| format!("{} {}", c["name"].as_str().unwrap_or(""), dur(c["sec"].as_f64().unwrap_or(0.0)))).collect();
            format!("{} {}（{}）", g["name"].as_str().unwrap_or(""), dur(g["sec"].as_f64().unwrap_or(0.0)), kids.join("、"))
        }).collect()
    };
    let (domains, acts) = (tree("domains"), tree("activities"));
    let rules: Vec<(String, String, Option<bool>)> = crate::data::get_rules()
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|r| r["enabled"] != false)
        .map(|r| {
            let text = r["text"].as_str().unwrap_or("").to_string();
            let (desc, ok) = check(&text, date, &day);
            (text, desc, ok)
        })
        .collect();
    let hours: Vec<String> = day["hours"].as_array().cloned().unwrap_or_default().iter()
        .filter(|h| h["title"] != "不在电脑前")
        .map(|h| {
            let t = h["start"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Local).hour()).unwrap_or(0);
            format!("{t:02}:00 {}：{}", h["title"].as_str().unwrap_or(""), h["description"].as_str().unwrap_or(""))
        })
        .collect();
    // 当前这个小时还没有小时摘要：补上最近的 10 分钟摘要
    let recent: Vec<String> = day["segments"].as_array().cloned().unwrap_or_default().iter().rev().take(6)
        .filter(|s| s["kind"] == "10min" && s["source"] == "beayy")
        .map(|s| format!("{} {}：{}", s["start"].as_str().and_then(|x| DateTime::parse_from_rfc3339(x).ok()).map(|t| t.with_timezone(&Local).format("%H:%M").to_string()).unwrap_or_default(), s["title"].as_str().unwrap_or(""), s["description"].as_str().unwrap_or("")))
        .collect();

    let mut user = format!("日期：{}\n\n", date.format("%Y-%m-%d"));
    user += &format!("时长：\n- {}\n\n", stats.join("\n- "));
    if !domains.is_empty() {
        user += &format!("为了什么（领域、项目）：\n- {}\n\n在做什么（类型）：\n- {}\n\n", domains.join("\n- "), acts.join("\n- "));
    }
    if !rules.is_empty() {
        user += &format!("规矩：\n{}\n\n", rules.iter().map(|(t, d, ok)| format!("- {t}：{d}{}", match ok { Some(true) => "，守住了", Some(false) => "，没守住", None => "" })).collect::<Vec<_>>().join("\n"));
    }
    user += &format!("每小时：\n{}\n\n最近：\n{}\n", hours.join("\n"), recent.join("\n"));
    if let Some((_, rows)) = &places {
        user += &format!("\n去了哪：\n{}\n", rows.join("\n"));
    }
    if let Some((_, rows)) = &speech {
        user += &format!("\n对话（录音转写，挑说得多的几个小时，每小时截前面一部分；说话人分不准，标【你】的是你说的）：\n{}\n", rows.join("\n"));
    }
    let sm = beayy_summary::Summarizer::new(default_root());
    let j = sm.ask(PROMPT, &user)?;
    let list = |k: &str| -> String {
        let v: Vec<String> = j.get(k).and_then(Value::as_array).cloned().unwrap_or_default().iter().filter_map(|x| x.as_str().map(|s| format!("- {s}"))).collect();
        if v.is_empty() { "- 没有".into() } else { v.join("\n") }
    };
    let weekday = ["日", "一", "二", "三", "四", "五", "六"][date.format("%w").to_string().parse::<usize>().unwrap_or(0)];
    let mut md = format!(
        "# {} 周{weekday}\n\n> 由 Beayy 用当天的记录生成，数据截至 {}。\n\n## 今天的一句话\n\n{}\n\n## 时间都去哪了\n\n- {}\n",
        date.format("%m-%d"),
        Local::now().format("%m-%d %H:%M"),
        j.get("line").and_then(Value::as_str).unwrap_or("").trim(),
        stats.join("\n- ")
    );
    if !domains.is_empty() {
        md += &format!("\n为了什么：\n\n- {}\n\n在做什么：\n\n- {}\n", domains.join("\n- "), acts.join("\n- "));
    }
    md += &format!("\n## 做成了什么\n\n{}\n", list("done"));
    if !rules.is_empty() {
        md += &format!("\n## 规矩\n\n{}\n", rules.iter().map(|(t, d, ok)| format!("- {} {t}：{d}", match ok { Some(true) => "✓", Some(false) => "✗", None => "·" })).collect::<Vec<_>>().join("\n"));
    }
    md += &format!("\n## 偏离\n\n{}\n\n## 明天\n\n{}\n", list("drift"), list("tomorrow"));
    let p = path_of(date);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&p, &md).map_err(|e| e.to_string())?;
    Ok(md)
}

// ---------- 周总结：用那一周的日总结写 ----------

const WEEK_PROMPT: &str = "你是用户的日记助手。下面是用户这一周每天的日总结（有的天可能没有）。
据此写这一周的周总结，全部用中文，用第二人称「你」，写得具体、平实，不夸、不说教。只写材料里有的事，不编造，不写材料里没有的数字。
只返回一个 JSON 对象，不要代码块，字段：
  line: 这一周的一句话，40 字以内，抓住这周最主要的事和状态
  done: 3–6 条字符串，这周做成或推进了什么（写结果，不写过程；同一件事跨几天的合成一条）
  pattern: 1–3 条字符串，时间和作息的规律：时间主要花在哪、哪几天偏多偏少、熬夜和手机的情况
  drift: 0–3 条字符串，偏离：反复没守住的规矩、被不重要的事占掉的时间；没有就空数组
  next: 1–3 条字符串，下周最值得做的事，从这周没做完的里挑
";

/// 一句话：日总结里「今天的一句话」下面那行
fn line_of(md: &str) -> Option<String> {
    let mut it = md.lines().skip_while(|l| !l.starts_with("## 今天的一句话")).skip(1);
    it.find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string())
}

/// 写周一是 monday 的那周的周总结（结果记进 state.json）；返回 Markdown
pub fn generate_week(monday: NaiveDate) -> Result<String, String> {
    let r = write_week(monday);
    record("weeks", &monday.format("%Y-%m-%d").to_string(), 0, &r);
    r
}

fn write_week(monday: NaiveDate) -> Result<String, String> {
    let days: Vec<(NaiveDate, String)> = (0..7)
        .map(|k| monday + Duration::days(k))
        .filter_map(|d| fs::read_to_string(path_of(d)).ok().map(|t| (d, t)))
        .collect();
    if days.is_empty() {
        return Err("这周还没有日总结".into());
    }
    let user: String = days.iter().map(|(d, t)| {
        let body: String = t.lines().filter(|l| !l.starts_with('>') && !l.starts_with("# ")).collect::<Vec<_>>().join("\n");
        format!("==== {} 周{} ====\n{}\n\n", d.format("%Y-%m-%d"), ["日", "一", "二", "三", "四", "五", "六"][d.format("%w").to_string().parse::<usize>().unwrap_or(0)], body.trim())
    }).collect();
    let sm = beayy_summary::Summarizer::new(default_root());
    let j = sm.ask(WEEK_PROMPT, &user)?;
    let list = |k: &str| -> String {
        let v: Vec<String> = j.get(k).and_then(Value::as_array).cloned().unwrap_or_default().iter().filter_map(|x| x.as_str().map(|s| format!("- {s}"))).collect();
        if v.is_empty() { "- 没有".into() } else { v.join("\n") }
    };
    let sunday = monday + Duration::days(6);
    let md = format!(
        "# {} – {} 周总结\n\n> 由 Beayy 用这一周的 {} 份日总结生成，数据截至 {}。\n\n## 这周的一句话\n\n{}\n\n## 做成了什么\n\n{}\n\n## 时间和作息\n\n{}\n\n## 偏离\n\n{}\n\n## 下周\n\n{}\n",
        monday.format("%m-%d"),
        sunday.format("%m-%d"),
        days.len(),
        Local::now().format("%m-%d %H:%M"),
        j.get("line").and_then(Value::as_str).unwrap_or("").trim(),
        list("done"),
        list("pattern"),
        list("drift"),
        list("next")
    );
    let p = week_path(monday);
    fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    fs::write(&p, &md).map_err(|e| e.to_string())?;
    Ok(md)
}

// ---------- 页面用的命令 ----------

/// 页面上「现在生成」
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn generate_daily(date: String) -> Result<String, String> {
    let d = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    generate(d)
}

/// 这一天的日总结最近一次没写成：{error, at}；写成了或没试过返回 null
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub fn daily_status(date: String) -> Value {
    let e = &read_state()["days"][&date];
    if e["error"].is_string() && !path_of(NaiveDate::parse_from_str(&date, "%Y-%m-%d").unwrap_or_default()).exists() {
        serde_json::json!({"error": e["error"], "at": e["failed_at"]})
    } else {
        Value::Null
    }
}

/// 某天所在那周：{monday, sunday, summary_md, error, days: [{date, line}]}
#[cfg_attr(not(beayy_mobile), tauri::command)]
pub fn get_week(date: String) -> Result<Value, String> {
    let d = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    let monday = monday_of(d);
    let days: Vec<Value> = (0..7).map(|k| {
        let x = monday + Duration::days(k);
        let line = fs::read_to_string(path_of(x)).ok().and_then(|t| line_of(&t));
        serde_json::json!({"date": x.format("%Y-%m-%d").to_string(), "line": line})
    }).collect();
    let key = monday.format("%Y-%m-%d").to_string();
    let e = &read_state()["weeks"][&key];
    Ok(serde_json::json!({
        "monday": key,
        "sunday": (monday + Duration::days(6)).format("%Y-%m-%d").to_string(),
        "summary_md": fs::read_to_string(week_path(monday)).ok(),
        "error": if e["error"].is_string() { e["error"].clone() } else { Value::Null },
        "days": days,
    }))
}

#[cfg_attr(not(beayy_mobile), tauri::command)]
pub async fn generate_weekly(date: String) -> Result<String, String> {
    let d = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|e| e.to_string())?;
    generate_week(monday_of(d))
}

// ---------- 定时 ----------

fn modified(p: &PathBuf) -> Option<DateTime<Local>> {
    fs::metadata(p).and_then(|m| m.modified()).ok().map(DateTime::<Local>::from)
}

/// 上次失败的还没到重试时间
fn waiting(e: &Value) -> bool {
    e["retry_at"].as_i64().map(|t| t > Utc::now().timestamp()).unwrap_or(false)
}

/// 前几天要不要（重）写：缺的、按旧写法写的、当天晚上写的（那天还没过完）、之后又来了不少数据的
fn day_due(d: NaiveDate, st: &Value) -> bool {
    let e = &st["days"][d.format("%Y-%m-%d").to_string()];
    let bytes = input_bytes(d);
    let old = e["bytes"].as_u64().unwrap_or(0);
    // 别的设备晚到的（电脑自己那天的在 0:15 重写时已经齐了）
    let grew = bytes > old + 32 * 1024;
    if e["error"].is_string() {
        // 这一天没记录：数据来了再试；别的错：到点再试
        return if e["empty"] == true { grew } else { !waiting(e) };
    }
    if !path_of(d).exists() || e["v"].as_i64().unwrap_or(0) < VERSION {
        return true;
    }
    let at = e["at"].as_i64().and_then(|t| DateTime::from_timestamp(t, 0)).map(|t| t.with_timezone(&Local).date_naive());
    at.map(|a| a <= d).unwrap_or(true) || grew
}

/// 过完的周要不要（重）写：那周有日总结，周总结没写、或之后那周的日总结又重写过
fn week_due(monday: NaiveDate, st: &Value) -> bool {
    let e = &st["weeks"][monday.format("%Y-%m-%d").to_string()];
    if e["error"].is_string() && waiting(e) {
        return false;
    }
    let newest = (0..7).filter_map(|k| modified(&path_of(monday + Duration::days(k)))).max();
    match (newest, modified(&week_path(monday))) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(n), Some(w)) => n > w,
    }
}

/// 命令行 --daily catch-up：一轮轮补到没有要写的（每轮都会写的说明有问题，最多 10 轮）
pub fn catch_up_all() {
    for _ in 0..10 {
        if catch_up(Local::now().date_naive()) == 0 {
            break;
        }
    }
}

/// 补：最近 7 天的日总结、最近两周的周总结。一轮最多写 2 份，剩下的下一轮；返回这轮试着写了几份
fn catch_up(today: NaiveDate) -> usize {
    let st = read_state();
    let mut n = 0;
    for k in 1..=7 {
        let d = today - Duration::days(k);
        if n < 2 && day_due(d, &st) {
            let _ = generate(d);
            n += 1;
        }
    }
    if n > 0 {
        return n; // 日总结刚重写过，周总结下一轮再看
    }
    let this = monday_of(today);
    for w in [this - Duration::days(7), this - Duration::days(14)] {
        if n < 2 && week_due(w, &st) {
            let _ = generate_week(w);
            n += 1;
        }
    }
    n
}

/// 定时：每天 21:30 写当天；每 10 分钟看一遍前几天和前两周
pub fn start(paused: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        if paused.load(std::sync::atomic::Ordering::Relaxed) {
            continue;
        }
        let now = Local::now();
        let today = now.date_naive();
        if (now.hour(), now.minute()) >= (21, 30) && !path_of(today).exists() && !waiting(&read_state()["days"][today.format("%Y-%m-%d").to_string()]) {
            let _ = generate(today);
        }
        // 0:15 以前前一天可能还在记（熬夜），不急着重写
        if now.minute() % 10 == 3 && (now.hour(), now.minute()) >= (0, 15) {
            let _ = catch_up(today);
        }
    });
}
