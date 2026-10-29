// Beayy 网页界面：今天、日总结、规矩、设置四页。纯 JS，不用打包工具。
// 取数：Tauri 里用 window.__TAURI__.core.invoke（命令见 app/src-tauri/COMMANDS.md）；
// 浏览器里读 mock/<命令名>.json（双击 file:// 打开时改读 mock/mock.js）。
// 作息图、一天的形状、读数的画法取自 网站/static/app.js（设计系统「人生记录」）。

const $app = document.getElementById("app");
const TAURI = window.__TAURI__ && window.__TAURI__.core;
// Android：外壳往 WebView 里注入了 AndroidBridge（Kotlin 转发 Rust 的 dispatch）。
// 接口约定和 Tauri 同一套：命令名相同、args 相同、返回 {ok}/{err} 的 JSON 文本。
const ANDROID = window.AndroidBridge && typeof window.AndroidBridge.bridge === "function";
// 手机版没有开发者工具：网页报错交给外壳记进日志（电脑版没有这个命令，调用失败就算了）
if (TAURI) {
  const report = (t) => { try { TAURI.invoke("web_log", { text: t }).catch(() => {}); } catch (e) {} };
  window.addEventListener("error", (e) => report(`${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => report(`未处理：${e.reason && (e.reason.stack || e.reason.message || e.reason)}`));
}

// ---------- 取数 ----------

let MOCK = null;
const mockState = {};

async function loadMock(name) {
  if (location.protocol !== "file:") {
    try {
      const r = await fetch(`mock/${name}.json`, { cache: "no-cache" });
      if (r.ok) return r.json();
    } catch (e) { /* 退回 mock.js */ }
  }
  if (!MOCK) {
    await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "mock/mock.js"; s.onload = ok; s.onerror = () => fail(new Error("读不到 mock/mock.js，先跑 mock/make_mock.py"));
      document.head.appendChild(s);
    });
    MOCK = window.BEAYY_MOCK;
  }
  return JSON.parse(JSON.stringify(MOCK[name]));
}

async function call(cmd, args = {}) {
  if (TAURI) return TAURI.invoke(cmd, args);
  // Android：Kotlin 桥是同步的，返回 JSON 文本；包一层 Promise 还原 Tauri 语义
  if (ANDROID) {
    return new Promise((resolve, reject) => {
      try {
        const out = JSON.parse(window.AndroidBridge.bridge(cmd, JSON.stringify(args)));
        if (out && out.ok !== undefined) resolve(out.ok);
        else reject(new Error(out && out.err ? out.err : "命令失败"));
      } catch (e) { reject(e); }
    });
  }
  switch (cmd) {
    case "save_rules": mockState.rules = args.rules; return null;
    case "save_settings": mockState.settings = { ...(mockState.settings || await loadMock("get_settings")), ...args.settings }; return null;
    case "set_api_key": mockState.hasKey = true; return null;
    case "set_paused": mockState.paused = args.paused; return null;
    case "open_permission": case "open_data_dir": console.info(`样例模式：${cmd}`, args); return null;
    case "get_rules": return mockState.rules || loadMock("get_rules");
    case "get_settings": {
      const s = mockState.settings || await loadMock("get_settings");
      if (mockState.hasKey) s.has_api_key = true;
      return s;
    }
    case "model_ready": return { ready: true, missing: [], mode: "official", message: "" };
    case "llm_status": return { local: { mode: "official", ready: true, missing: [] }, quota: { plan: null } };
    case "get_status": {
      const s = await loadMock("get_status");
      if (mockState.paused !== undefined) s.paused = mockState.paused;
      return s;
    }
    case "get_day": return (await loadMock("get_day"))[args.date] || null;
    case "daily_status": return null;
    case "get_week": {
      const m = addDays(args.date, -((toDate(args.date).getDay() + 6) % 7));
      return { monday: m, sunday: addDays(m, 6), summary_md: null, error: null, days: Array.from({ length: 7 }, (_, k) => ({ date: addDays(m, k), line: null })) };
    }
    default: return loadMock(cmd);
  }
}

// ---------- 小工具 ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hh = (sec) => (sec == null ? "—" : (sec / 3600).toFixed(1));
const mins = (sec) => (sec == null ? "—" : String(Math.round(sec / 60)));
// 时间都按这台电脑的本地时区显示（以前写死了东八区）
const pad2 = (n) => String(n).padStart(2, "0");
const toDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(y, m - 1, dd); };
const weekday = (d) => "周" + "日一二三四五六"[toDate(d).getDay()];
const short = (d) => `${d.slice(5)} ${weekday(d)}`;
const localDay = (t = new Date()) => `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`;
const hm = (iso) => { if (!iso) return ""; const t = new Date(iso); return `${pad2(t.getHours())}:${pad2(t.getMinutes())}`; };
const mdhm = (iso) => { if (!iso) return ""; const t = new Date(iso); return `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${hm(iso)}`; };
/** 带完整年月日的时刻（墨线文案：「同步至 2026-10-22 09:27」） */
const ymdhm = (iso) => { if (!iso) return ""; const t = new Date(iso); return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${hm(iso)}`; };
const addDays = (d, n) => localDay(new Date(toDate(d).getTime() + 12 * 3600e3 + n * 864e5));

/** 每小时秒数（电脑）：数据包的 active_hours {"09": 秒}，或老数据包的 hours {"09": {app: 秒}} */
function hourSecs(c) {
  c = c || {};
  const h = c.active_hours || Object.fromEntries(Object.entries(c.hours || {}).map(([k, v]) => [k, typeof v === "number" ? v : Object.values(v).reduce((a, b) => a + b, 0)]));
  return Array.from({ length: 24 }, (_, i) => h[String(i).padStart(2, "0")] || 0);
}

/** 区间 [[ISO, ISO]] 落在某天 hour 点以后的秒数 */
function secsAfter(spans, date, hour) {
  const from = toDate(date).getTime() + hour * 3600e3, to = toDate(date).getTime() + 864e5;
  return spans.reduce((s, [a, b]) => s + Math.max(0, Math.min(Date.parse(b), to) - Math.max(Date.parse(a), from)) / 1000, 0);
}

/** 每小时分钟数：接受数组（分钟）或 {"09": 秒} */
function hourMinutes(h) {
  if (Array.isArray(h)) return Array.from({ length: 24 }, (_, i) => h[i] || 0);
  return Array.from({ length: 24 }, (_, i) => Math.min(60, Math.round(((h || {})[String(i).padStart(2, "0")] || 0) / 60)));
}

const ICON = {
  chevL: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
  chevR: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  chevD: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg>',
  check: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  close: '<svg class="mx-ico" viewBox="0 0 16 16"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  more: '<svg class="mx-ico" viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none"/></svg>',
};
const ANDROID_SETTING_ICONS = {
  accessibility: '<svg class="mx-ico lu" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><path d="M5 9h14M12 9v11M8 20l4-6 4 6"/></svg>',
  usage: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 16v-5M12 16V8M16 16v-2"/></svg>',
  notifications: '<svg class="mx-ico lu" viewBox="0 0 24 24"><path d="M6 10a6 6 0 0 1 12 0c0 5 2 5 2 7H4c0-2 2-2 2-7M10 20h4"/></svg>',
  battery: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10v4M7 10v4M10 10v4"/></svg>',
  auto_start: '<svg class="mx-ico lu" viewBox="0 0 24 24"><path d="M12 3v10M8 6a8 8 0 1 0 8 0"/></svg>',
  hide_ongoing: '<svg class="mx-ico lu" viewBox="0 0 24 24"><path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3M9 11v5M15 11v5"/></svg>',
  hide_recents: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 9h8M8 13h5M8 17h8"/></svg>',
  keep_alive: '<svg class="mx-ico lu" viewBox="0 0 24 24"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/><circle cx="12" cy="12" r="3"/></svg>',
};
const androidSettingLabel = (key, name) => `<span class="android-setting-label"><span class="android-setting-icon" aria-hidden="true">${ANDROID_SETTING_ICONS[key] || ""}</span><span>${esc(name)}</span></span>`;

// 极简 Markdown：小标题、列表、段落，行内粗体和代码。先转义再加标记。
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) { close(); continue; }
    let m;
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { close(); out.push(`<h5>${inline(m[1])}</h5>`); }
    else if ((m = line.match(/^[-*]\s+(.*)/))) { if (list !== "ul") { close(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\d+[.、]\s*(.*)/))) { if (list !== "ol") { close(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (line.startsWith(">")) { close(); out.push(`<p class="note">${inline(line.replace(/^>\s*/, ""))}</p>`); }
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return `<div class="md">${out.join("")}</div>`;
}

/** 按 ## 切日总结：开头的引用块是口径说明 */
function splitSummary(text) {
  const parts = []; let note = []; let cur = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("## ")) { cur = { title: line.slice(3).trim(), body: [] }; parts.push(cur); }
    else if (cur) cur.body.push(line);
    else if (line.startsWith(">")) note.push(line.replace(/^>\s*/, ""));
  }
  return { note: note.join(" "), parts: parts.map((p) => ({ title: p.title, body: p.body.join("\n").trim() })) };
}

// ---------- 页面骨架 ----------

function header(title, right = "") {
  return `<header class="mx-head"><div class="mx-head-row" data-tauri-drag-region><h1 class="mx-title">${esc(title)}</h1><div class="mx-head-right">${right}</div></div></header>`;
}

/**
 * 手机独有的信号：通知、媒体播放、电量、网络。
 *
 * 这些是 Android 才采得到的事件（桌面和 iOS 没有），以前只存在数据里、界面上看不见。
 * 只在「手机」页签下显示；没有数据时返回空串，不占位置。
 */
function phoneExtraBlock(x) {
  if (!x || typeof x !== "object") return "";
  const notif = Array.isArray(x.notifications) ? x.notifications : [];
  const media = Array.isArray(x.media) ? x.media : [];
  const battery = Array.isArray(x.battery) ? x.battery : [];
  const net = Array.isArray(x.network) ? x.network : [];
  if (!notif.length && !media.length && !battery.length && !net.length) return "";
  const hhmm = (t) => { const d = new Date(t); return isNaN(d) ? "" : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  const blocks = [];
  if (notif.length) {
    const rows = notif.slice(-20).reverse().map((n) =>
      `<li><span class="mono">${hhmm(n.at)}</span> ${esc(n.app)}${n.title ? ` · ${esc(n.title)}` : ""}</li>`).join("");
    blocks.push(section("谁来找过你", `<ul class="pe-list">${rows}</ul>`, { count: notif.length }));
  }
  if (media.length) {
    const rows = media.slice(-20).reverse().map((m) =>
      `<li><span class="mono">${hhmm(m.at)}</span> ${esc(m.app)}${m.title ? ` · ${esc(m.title)}` : ""}${m.artist ? ` <span class="note">${esc(m.artist)}</span>` : ""}</li>`).join("");
    blocks.push(section("在听/在看", `<ul class="pe-list">${rows}</ul>`, { count: media.length }));
  }
  if (battery.length) {
    const seen = new Set();
    const rows = battery.filter((b) => {
      const k = `${b.charging}|${Math.floor((b.percent || 0) / 20)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(-10).map((b) =>
      `<li><span class="mono">${hhmm(b.at)}</span> ${b.percent == null ? "?" : b.percent}% ${b.charging ? "充电中" : "用电中"}${b.plugged ? ` <span class="note">${esc(b.plugged)}</span>` : ""}</li>`).join("");
    blocks.push(section("电量", `<ul class="pe-list">${rows}</ul>`));
  }
  if (net.length) {
    const rows = net.slice(-10).map((n) =>
      `<li><span class="mono">${hhmm(n.at)}</span> ${esc(n.type || "未知")}${n.online === false ? " · 没网" : ""}</li>`).join("");
    blocks.push(section("网络", `<ul class="pe-list">${rows}</ul>`));
  }
  return blocks.length ? `<div class="pe-extra">${blocks.join("")}</div>` : "";
}

/**
 * 模型配置的同步说明：网关和模型名会跟着账号走（密钥不会），新设备登录后自动带上。
 * 从别的设备同步下来但本机还没填密钥时，要明确说一句——不然用户不知道摘要为什么还是不出。
 */
function modelSyncHint(cf) {
  const synced = S.sync && S.sync.configured;
  if (!synced) return "";
  if (!cf.has_api_key) return `<br><span class="note">配置已从账号同步下来，但这台设备还没有密钥——摘要不会生成，点右边「设置」补上。</span>`;
  return `<br><span class="note">网关和模型名与账号同步（密钥只存本机）</span>`;
}

function modelBanner() {
  const m = S.modelReady || { ready: true, message: "" };
  if (S.bannerOff || m.ready) return "";
  const msg = m.message || "还没配置模型，不会生成摘要。";
  return `<div class="model-banner" role="alert">
    <span class="model-banner-text">${esc(msg)}</span>
    <button type="button" class="model-banner-go" id="model-banner-go">去设置</button>
    <button type="button" class="model-banner-x" id="model-banner-x" aria-label="知道了">×</button>
  </div>`;
}

/** 横幅上的两个按钮（每次渲染后绑一次） */
function bindModelBanner() {
  const go = document.getElementById("model-banner-go");
  if (go) go.onclick = () => { location.hash = "#/settings"; };
  const x = document.getElementById("model-banner-x");
  if (x) x.onclick = () => { S.bannerOff = true; route(); };
}

/** Android 专有的后台开关。 */
function androidBackgroundRows(cf) {
  const hide = !!cf.hide_ongoing, keep = cf.keep_alive !== false, hideR = !!cf.hide_recents;
  return setRow(androidSettingLabel("hide_ongoing", "隐藏通知"), "开着时通知栏看不到 Beayy。进程在「应用 → 正在运行」里仍可见；藏起来也可能被系统回收得更快。", `<button class="mx-switch" role="switch" id="hide-ongoing" aria-checked="${hide}" aria-label="隐藏通知"></button>`)
    + setRow(androidSettingLabel("hide_recents", "隐藏最近任务"), "开着时 Beayy 不出现在多任务切换界面，也降低了被顺手划掉的概率。", `<button class="mx-switch" role="switch" id="hide-recents" aria-checked="${hideR}" aria-label="隐藏最近任务"></button>`)
    + setRow(androidSettingLabel("keep_alive", "挂了自动拉起来"), "从最近任务划掉、被省电清理掉之后，过几秒自动重启。手机重启也会自己起来（需要「自启动」权限）。", `<button class="mx-switch" role="switch" id="keep-alive" aria-checked="${keep}" aria-label="挂了自动拉起来"></button>`);
}
const section = (title, body, { count, aside } = {}) =>
  `<section class="mx-sec"><div class="mx-sec-head"><h3>${esc(title)}</h3>${count != null ? `<span class="mx-count">${count}</span>` : ""}${aside ? `<span class="mx-sec-aside">${aside}</span>` : ""}</div>${body}</section>`;
const emptyInline = (text) => `<p class="mx-empty-inline">${esc(text)}</p>`;
/** 「怎么设置」链接（墨线文案：要分步骤的设置，界面一句话＋这个链接，步骤在弹层里） */
const howto = (kind, text) => `<button type="button" class="howto" data-howto="${kind}">${esc(text)}</button>`;
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-howto]"); if (!b) return;
  ({ screentime: ANDROID ? androidPhoneDialog : screenTimeDialog, phone_recording: androidPhoneDialog, phone_capture: androidPhoneDialog, amap: amapHowtoDialog })[b.dataset.howto]?.();
}, true);

/** iCloud 屏幕使用时间怎么同步到这台 Mac：四步＋打开系统设置、现在读取 */
function screenTimeDialog() {
  // 手机版不读屏幕使用时间（电脑读），没有这两个按钮
  const desk = TAURI && !(S.status && S.status.mobile) && !IS_WIN;
  openDialog({
    title: "iPhone 屏幕使用时间", cancel: "关闭", ok: desk ? "现在读取" : null, busy: "读取中…",
    body: `<ol class="steps">
      <li>iPhone：设置 → 屏幕使用时间 → 打开「跨设备共享」</li>
      <li>Mac：系统设置 → 屏幕使用时间 → 打开「跨设备共享」</li>
      <li>两台用同一个 Apple ID</li>
      <li>想快点同步：在 iPhone 和 Mac 上各打开一次「屏幕使用时间」</li></ol>
      ${desk ? `<button class="mx-btn mx-btn--secondary mx-btn--sm" style="align-self:flex-start" id="st-open">打开系统设置</button>` : ""}`,
    onOpen: (el) => { const b = el.querySelector("#st-open"); if (b) b.onclick = () => call("open_permission", { kind: "screentime" }); },
    submit: async () => {
      await call("phone_read_now");
      await new Promise((r) => setTimeout(r, 4000));
      S.status = await call("get_status").catch(() => S.status);
      route();
    },
  });
}
function androidPhoneDialog() {
  openDialog({ title: "Android 手机记录", cancel: "关闭", ok: null,
    body: `<p>Android 由 Beayy 在本机采集，不经过 iCloud。要记录完整：到「我的 → 设置 → 通用」开启无障碍、使用情况访问；通知、电池白名单和自启动按需授权。</p><p class="note">无障碍负责读取正在看的界面文字；使用情况访问负责 app 前台时长。密码框不会记录。</p>` });
}
/** 高德 Key 怎么获取 */
function amapHowtoDialog() {
  openDialog({
    title: "怎么获取高德 Key", cancel: "关闭", ok: null,
    body: `<ol class="steps">
      <li>打开 console.amap.com，用高德账号登录，完成开发者认证</li>
      <li>应用管理 → 创建新应用</li>
      <li>添加 Key，服务平台选「Web 服务」：这是 Web 服务 Key</li>
      <li>再添加一个 Key，服务平台选「Web端(JS API)」：这是地图 Key，它下面的安全密钥一起填</li></ol>
      <p class="note">不想填 Key，可以开通官方服务。</p>`,
  });
}

// ---------- 弹层（墨线 Dialog 小窗口）：新建、编辑、填几项再提交都在这里，页面上不展开编辑框 ----------
// 同一时间只开一个，挂在 body 上，页面重画不影响它。点遮罩、Esc、关闭都等于取消；提交中不关。

let DLG = null;

/** title、body（HTML）、ok（主按钮文字）、okClass（primary／danger）、busy（提交中的按钮文字）、cancel（false＝不要取消钮）、
 *  closable（false＝只能点主按钮关）、submit(el)：抛错就把错写在窗口里、不关，返回 false 也不关；onOpen(el, d) 绑窗口里的交互 */
function openDialog({ title, body, ok, okClass = "primary", busy, cancel = "取消", closable = true, submit, onOpen }) {
  closeDialog();
  const root = document.createElement("div");
  root.className = "mx-scrim dlg-root";
  root.innerHTML = `<div class="mx-dialog mx-dialog--sm" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <div class="mx-dialog-head"><h2 id="dlg-title">${esc(title)}</h2>${closable ? `<button class="mx-iconbtn" data-dlg="close" aria-label="关闭">${ICON.close}</button>` : ""}</div>
    <div class="mx-dialog-body">${body}<div class="mx-field-error" data-dlg="err" hidden></div></div>
    <div class="mx-dialog-foot">${cancel ? `<button class="mx-btn mx-btn--secondary" data-dlg="close">${esc(cancel)}</button>` : ""}${ok ? `<button class="mx-btn mx-btn--${okClass}" data-dlg="ok">${esc(ok)}</button>` : ""}</div></div>`;
  document.body.appendChild(root);
  const el = root.querySelector(".mx-dialog"), okBtn = root.querySelector('[data-dlg="ok"]'), err = root.querySelector('[data-dlg="err"]');
  const d = (DLG = { root, el, closable, busy: false, back: document.activeElement });
  d.setErr = (m) => { err.hidden = !m; err.textContent = m || ""; };
  d.setOk = (text) => { if (okBtn) okBtn.textContent = text; };
  d.go = async () => {
    if (d.busy || !okBtn || okBtn.disabled) return;
    const label = okBtn.textContent;
    d.busy = true; okBtn.disabled = true; d.setErr(null); if (busy) okBtn.textContent = busy;
    try { if ((await submit(el, d)) !== false) { d.busy = false; return closeDialog(); } }
    catch (x) { d.setErr(String(x && x.message ? x.message : x)); }
    d.busy = false; okBtn.disabled = false; okBtn.textContent = label;
  };
  const cancelable = () => closable && !d.busy;
  root.addEventListener("mousedown", (e) => { if (e.target === root && cancelable()) closeDialog(); });
  root.addEventListener("click", (e) => { const b = e.target.closest("[data-dlg]"); if (!b) return; if (b.dataset.dlg === "close" && cancelable()) closeDialog(); else if (b.dataset.dlg === "ok") d.go(); });
  root.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") { if (cancelable()) closeDialog(); return; }
    // 单行输入框里回车、任何地方 ⌘↩ 都等于点主按钮；输入法选字时的回车不算
    if (e.key === "Enter" && !e.isComposing && (e.metaKey || e.target.tagName === "INPUT")) { e.preventDefault(); d.go(); return; }
    if (e.key === "Tab") {
      const fs = [...el.querySelectorAll("button:not(:disabled), input:not([hidden]), textarea, [tabindex='0']")];
      if (!fs.length) return;
      const i = fs.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); fs[fs.length - 1].focus(); }
      else if (!e.shiftKey && i === fs.length - 1) { e.preventDefault(); fs[0].focus(); }
    }
  });
  if (onOpen) onOpen(el, d);
  const first = el.querySelector(".mx-dialog-body input:not([hidden]), .mx-dialog-body textarea") || okBtn || el.querySelector("[data-dlg]");
  if (first) { first.focus(); if (first.setSelectionRange && first.value) first.setSelectionRange(first.value.length, first.value.length); }
  return d;
}

function closeDialog() {
  const d = DLG; if (!d) return;
  DLG = null; d.root.remove();
  if (d.back && d.back.isConnected && d.back.focus) d.back.focus();
}

/** 弹层里的一项输入 */
const dlgField = (id, label, { type = "text", ph = "", value = "", mono = false, help = "" } = {}) =>
  `<div class="mx-field"><label for="${id}">${label}</label><input class="mx-input${mono ? " mono" : ""}" id="${id}" type="${type}" autocomplete="off" placeholder="${esc(ph)}" value="${esc(value)}">${help ? `<p class="note">${help}</p>` : ""}</div>`;
const dlgVal = (el, id) => { const x = el.querySelector("#" + id); return x ? x.value.trim() : ""; };

// ---------- 人生记录：读数、一天的形状、作息图 ----------

const shade = (min, v) => (min ? `background:color-mix(in srgb, var(${v}) ${Math.round(30 + (Math.min(min, 60) / 60) * 70)}%, var(--rec-track))` : "");
const isNight = (h) => h >= 21 || h < 5;

/** 读数：两行，标签和数值（单位跟在后面）。caption（时段、同步时刻这类补充）和 tip 都放悬停里，不占第三行
 *  （三行太累赘；墨线：读数不配解释文字，要解释放悬停） */
function readout(k, v, unit, caption = "", over = false, tip = "") {
  const hint = [caption, tip].filter(Boolean).join("\n");
  return `<div class="ro${over ? " over" : ""}"${hint ? ` title="${esc(hint)}"` : ""}><div class="label">${esc(k)}</div><div class="v">${esc(v)}${unit ? `<small>${esc(unit)}</small>` : ""}</div></div>`;
}

/** 一天的形状。只给电脑、手机两排时照旧（上排电脑、下排手机）；给了 opt（手表说话的分钟数 hw、停留点 visits、日期 date）
 *  就按设备一排一排、行首写设备名，最上面一排地点。电脑、手机、说话每小时一格占满，用得越久越深；
 *  地点是一整条，每段停留按起止画、颜色跟着地方走，够宽的写地名。今天还没到的小时格只留空框；
 *  轴上每 3 小时写一个钟点（03:00） */
function dayStrip(hc, hp, clickable = false, opt = null) {
  const day0 = opt && opt.date ? toDate(opt.date).getTime() : 0, now = Date.now(), today = opt && now >= day0 && now < day0 + 864e5;
  const futH = today ? new Date(now).getHours() : 24;
  const cells = (arr, v, name, unit = "分钟") => arr.map((m, h) => `<span${h > futH ? ' class="fut"' : ""} style="${shade(m, v)}" title="${h}:00 ${name} ${m} ${unit}"${clickable ? ` data-h="${h}"` : ""}></span>`).join("");
  const axis = (n) => `<div class="strip-axis" aria-hidden="true">${Array.from({ length: n }, (_, h) => (h % 3 ? "<span></span>" : `<span class="t">${pad2(h)}<small>:00</small></span>`)).join("")}</div>`;
  if (!opt) return `<div role="img" aria-label="一天的形状：上排电脑，下排手机"><div class="strip">${cells(hc, "--rec-computer", "电脑")}${cells(hp, "--rec-phone", "手机")}</div>${axis(24)}</div>`;
  const frac = (ms) => Math.max(0, Math.min(1, (ms - day0) / 864e5));
  // 地点：一整条，每段停留按起止画，颜色跟着地方走（同 placeTones，和下面「地点」列表一个颜色）；
  // 够宽的写地名，窄的只在悬停里有；两段之间的路上是灰色块
  const placeRow = () => {
    const tones = placeTones(opt.visits, opt.date);
    const pos = (a, z) => `left:${(frac(a) * 100).toFixed(3)}%;width:${(Math.max(frac(z) - frac(a), 0.002) * 100).toFixed(3)}%`;
    const bars = placeBlocks(opt.visits, opt.date).map((b) => {
      if (b.kind === "go") return `<i class="go" style="${pos(b.a, b.z)}" title="路上 ${hmMs(b.a)}–${hmMs(b.z)} ${spanText((b.z - b.a) / 1000)}"${clickable ? ` data-h="${new Date(Math.max(b.a, day0)).getHours()}"` : ""}>${(b.z - b.a) / 3600e3 >= 1.2 ? "路上" : ""}</i>`;
      if (b.kind !== "stay") return "";
      const name = placeName(b.v), wide = (b.z - b.a) / 3600e3 >= 1.2;
      return `<i style="${pos(b.a, b.z)};background:var(--pl-${tones.get(placeKey(b.v))})" title="${esc(name)} ${visitSpan(b.v)}"${clickable ? ` data-h="${new Date(Math.max(b.a, day0)).getHours()}"` : ""}>${wide ? esc(name) : ""}</i>`;
    }).join("");
    return `<div class="place-bar">${bars}</div>`;
  };
  const rows = [];
  if (opt.visits && opt.visits.length) rows.push(["地点", placeRow()]);
  rows.push(["电脑", `<div class="strip">${cells(hc, "--rec-computer", "电脑")}</div>`]);
  rows.push(["手机", `<div class="strip">${cells(hp, "--rec-phone", "手机")}</div>`]);
  // 说话：手表录的，和没戴手表时 iPhone 自己录的，合在一排
  if (opt.hw) rows.push(["说话", `<div class="strip">${cells(opt.hw, "--rec-watch", "说话")}</div>`]);
  return `<div role="img" aria-label="一天的形状：${rows.map((r) => r[0]).join("、")}各一排"><div class="strip-rows">${rows.map(([k, v, c]) => `<span class="k${c ? " " + c : ""}">${k}</span>${v}`).join("")}<span></span>${axis(24)}</div></div>`;
}

/** 「最近」：最近 14 天（照 Wise 支出洞察），每天一组两根柱子（电脑、手机），看的这一天实色、其他天淡；点哪天去哪天；
 *  不配平均之类的说明（不加非必要的注释）。范围到今天为止，看的这一天太早就以它为最后一天；没有记录的天不画柱子 */
function recentDays(date, cur) {
  const by = Object.fromEntries(S.days.map((x) => [x.date, x]));
  by[date] = { ...(by[date] || {}), date, active_sec: cur.c ?? (by[date] || {}).active_sec, phone_sec: cur.p ?? (by[date] || {}).phone_sec };
  const now = localDay(), end = date >= addDays(now, -13) ? now : date;
  const ds = Array.from({ length: 14 }, (_, i) => addDays(end, i - 13));
  const has = (x) => by[x] && (by[x].active_sec != null || by[x].phone_sec != null);
  const max = Math.max(3600, ...ds.filter(has).flatMap((x) => [by[x].active_sec || 0, by[x].phone_sec || 0]));
  const bar = (sec, cls) => `<i class="${cls}" style="height:${sec ? Math.max(2, Math.round((sec / max) * 100)) : 0}%"></i>`;
  const cols = ds.map((x) => {
    const v = by[x], ok = has(x), tip = ok ? `${short(x)} · 电脑 ${hh(v.active_sec)}h · 手机 ${hh(v.phone_sec)}h` : `${short(x)} · 取不到`;
    return `<button class="rd-col${x === date ? " is-cur" : ""}${ok ? "" : " none"}" ${ok || x === now ? `data-day="${x}"` : "disabled"} title="${esc(tip)}"><span class="rd-bars">${ok ? bar(v.active_sec, "c") + bar(v.phone_sec, "p") : ""}</span><span class="rd-d mono">${x === now ? "今" : +x.slice(8)}</span></button>`;
  }).join("");
  return section("最近", `<div class="rd" role="group" aria-label="最近 14 天每天在电脑前和用手机的时长">${cols}</div>`);
}

/** 地点的颜色：一共 6 种（--pl-1…6），按地名的哈希固定分配，同一个地方每天同一个颜色；
 *  同一天里撞色的往后挪一格（待得久的先挑）。一天的形状和「地点」列表共用 */
const PLACE_TONES = 6;
const placeKey = (v) => v.label || placeName(v).split(" · ")[0];
const hashStr = (s) => [...s].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7);
function placeTones(visits, date) {
  const tot = new Map();
  for (const b of placeBlocks(visits, date)) if (b.kind === "stay") tot.set(placeKey(b.v), (tot.get(placeKey(b.v)) || 0) + (b.z - b.a));
  const used = new Set(), out = new Map();
  for (const [k] of [...tot].sort((a, b) => b[1] - a[1])) {
    let t = hashStr(k) % PLACE_TONES;
    for (let i = 0; i < PLACE_TONES && used.has(t); i++) t = (t + 1) % PLACE_TONES;
    used.add(t);
    out.set(k, t + 1);
  }
  return out;
}

/** 两个停留点之间不超过 3 小时算「路上」，更长的和首尾算「没记到」（同 脚本/日数据包.py 的 TRANSIT_MAX） */
const TRANSIT_MAX = 3 * 3600e3;
/** 地点的显示名：起过名的用名字；没起名的不带区名，只有区域时写区域，确认了是哪家店写「区域 · 店」
 *  （手机用高德取的地名是「区 · 区域」，确认了店是「区 · 区域 · 店」；10-21 前苹果取的是「区 · 区域 · 门牌或店」） */
const placeName = (v) => {
  if (!v) return "没有地名";
  if (v.label) return v.label;
  const parts = (v.name || "").split(" · ");
  const n = (parts.length > 1 ? parts.slice(1).join(" · ") : parts[0]) || "没有地名";
  // 和家不在一个城市：前面写城市（「上海 · 静安寺」）
  return v.city_prefix ? `${String(v.city_prefix).replace(/市$/, "")} · ${n}` : n;
};
const visitEnd = (v) => (v.end ? Date.parse(v.end) : Date.now());
const pctText = (p) => `${Math.max(1, Math.round(p * 100))}%`;
/** 店名去掉括号里的分店名：「星巴克(某某广场店)」→「星巴克」（同手机） */
const shopShort = (n) => String(n || "").replace(/^(.+?)\s*[（(][^（()）]*[)）]$/, "$1").trim();
/** 还没确认是哪家店时，名字下面一行：在做什么（高德大类，置信度加总，手机算的）和最像的两家 */
function guessLine(v) {
  if (v.label || v.confirmed || !(v.guesses || []).length) return "";
  const parts = [];
  if (v.doing) parts.push(`${v.doing.kind} ${pctText(v.doing.p)}`);
  parts.push("可能是 " + v.guesses.slice(0, 2).map((g) => `${shopShort(g.name)} ${pctText(g.p)}`).join("、"));
  return parts.join(" · ");
}
/** 区域名（常去按它合计）：电脑取的分级里的区域，没有就用地名的第二层 */
const areaOf = (v) => (v.admin && v.admin.area) || ((v.place_name || v.name || "").split(" · ")[1]) || (v.place_name || v.name || "").split(" · ")[0];
/** 完整分级「中国 › 江苏省 › 南京市 › 江宁区 › 麒麟街道 › 南京江宁宝龙广场」（直辖市省市同名只写一次） */
function chainOf(v) {
  const a = v.admin || {};
  const xs = [a.country, a.province, a.city !== a.province ? a.city : null, a.district, a.township, a.area].filter(Boolean);
  return xs.join(" › ");
}
const cityShort = (c) => String(c || "").replace(/市$/, "");
/** 角标：起过名的写种类（家、工作、其他），没起名但最近 30 天去过 5 次以上的写「常去」，第一次去的不标 */
function badgeOf(v) {
  if (v.label) return PL_ICON[v.type] || "其他";
  const f = PL.stats && PL.stats.frequent;
  return f && f.some((r) => r.name === areaOf(v)) ? "常去" : "";
}
const badgeHtml = (v) => { const b = badgeOf(v); return b ? `<span class="pl-badge${b === "常去" ? " often" : ""}">${esc(b)}</span>` : ""; };

/** 地图上停留点的编号：1–9、A–Z（同高德静态地图的标注） */
const MARKS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const hmMs = (ms) => hm(new Date(ms).toISOString());
/** 停留的起止：从前一天待过来的写真实到达时刻（「昨天 22:10」），还没走的写「现在」 */
function visitSpan(v) {
  let a = hm(v.start);
  if (!v.arrive_known && v.arrive) {
    const t = new Date(v.arrive), y = new Date(Date.parse(v.start) - 864e5);
    a = (localDay(t) === localDay(y) ? "昨天 " : `${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} `) + hm(v.arrive);
  }
  return `${a}–${v.end ? hm(v.end) : "现在"}`;
}
const spanText = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} 分钟` : `${hh(sec)}h`);

/** 把一天按停留点切开：停留、两段之间的路上（≤ 3 小时）、没记到（更长的空档和首尾），按时间先后。只算到现在 */
function placeBlocks(visits, date) {
  const day0 = toDate(date).getTime(), stop = Math.min(Date.now(), day0 + 864e5);
  const vs = [...visits].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const out = [];
  let cur = day0;
  for (const v of vs) {
    const a = Date.parse(v.start), z = Math.min(visitEnd(v), stop);
    if (a > cur) out.push({ kind: cur > day0 && a - cur <= TRANSIT_MAX ? "go" : "none", a: cur, z: a });
    out.push({ kind: "stay", v, a, z });
    cur = Math.max(cur, z);
  }
  if (stop > cur) out.push({ kind: "none", a: cur, z: stop });
  return out.filter((b) => b.z > b.a);
}

/** 某段时间里待得最久的停留点 */
function placeAt(visits, a, z) {
  let best = null, most = 0;
  for (const v of visits || []) {
    const o = Math.min(z, visitEnd(v)) - Math.max(a, Date.parse(v.start));
    if (o > most) { most = o; best = v; }
  }
  return best;
}

/** 说话的时长：不到一小时写分钟 */
const talkText = (sec) => (sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} 分钟` : `${hh(sec)}h`);
/** 说话的人：按说话时长排，本人排第一 */
function speakers(talk, self) {
  return [...talk].sort((a, b) => (b.speaker === self) - (a.speaker === self) || b.sec - a.sec).map((t) => t.speaker);
}

/** 概览里的「去了哪」（照地图类产品的「时间线」）：上面一行汇总；左边按时间的竖线时间线（停留和路上交替，停留里套着那时的对话），
 *  右边地图（停留点按先后编号，点哪一行地图上那个点变成强调色）。名字只写有把握的；还没认出是哪家店的，下面一行列最像的几家，
 *  点一下就认定；每行右边「⋯」改地点（候选、附近、搜索、直接输入、起名）。不显示百分比（悬停能看） */
function placesSection(visits, date, convs, mode = "stays") {
  if (!visits.length) return "";
  const blocks = placeBlocks(visits, date);
  let go = 0;
  for (const b of blocks) if (b.kind === "go") go += (b.z - b.a) / 1000;
  const spots = new Set(visits.map((v) => v.label || placeName(v).split(" · ")[0])).size;
  const talk = (convs || []).length;
  // 当天在哪些城市、区：一个城市写「南京 · 江宁区、栖霞区」，跨城写「南京 → 上海」
  const cities = [...new Set(visits.map((v) => v.admin && v.admin.city).filter(Boolean))];
  const where = cities.length > 1 ? cities.map(cityShort).join(" → ")
    : cities.length ? `${cityShort(cities[0])} · ${[...new Set(visits.map((v) => v.admin && v.admin.district).filter(Boolean))].join("、")}` : "";
  const sum = [where, `${spots} 个地方`, `${visits.length} 段停留`, go ? `路上 ${spanText(go)}` : "", talk ? `说话 ${talk} 段` : ""].filter(Boolean).join(" · ");
  const idx = new Map(visits.map((v, i) => [v, i]));
  let first = true;
  const rows = blocks.map((b) => {
    if (b.kind === "stay") { first = false; return stayItem(b.v, idx.get(b.v), (convs || []).filter((c) => Date.parse(c.start) >= b.a && Date.parse(c.start) < b.z)); }
    if (first) return "";  // 一天开头没记到的不画
    const dur = spanText((b.z - b.a) / 1000);
    return b.kind === "go" ? `<li class="ptl-go"><span class="ptl-t"></span><span class="ptl-dot"></span><span class="ptl-b">路上 ${dur}</span></li>`
      : `<li class="ptl-none"><span class="ptl-t"></span><span class="ptl-dot"></span><span class="ptl-b">没记到 ${dur}</span></li>`;
  }).join("");
  if (mode === "map") {
    // 地图：左边一列简短的停留（编号、名字、起止），点哪段地图上那个点变成强调色；右边大地图
    const list = visits.map((v, i) => `<li><button class="pm-row" data-sel="${i}"><span class="ptl-dot">${MARKS[Math.min(i, MARKS.length - 1)]}</span><span class="pm-b"><span class="pm-n" title="${esc(chainOf(v))}">${esc(placeName(v))}${badgeHtml(v)}</span>${!v.label && !v.confirmed && (v.guesses || [])[0] ? `<span class="pm-m">可能是 ${esc(shopShort(v.guesses[0].name))} ${pctText(v.guesses[0].p)}</span>` : ["auto", "remembered"].includes(v.confirmed) && (v.guesses || [])[0] ? `<span class="pm-m">${v.confirmed === "auto" ? "自动认出" : "按上次认定"} ${pctText(v.guesses[0].p)}</span>` : ""}<span class="pm-m">${visitSpan(v)} · ${spanText((visitEnd(v) - Date.parse(v.start)) / 1000)}</span></span></button></li>`).join("");
    return `<p class="ptl-sum">${sum}</p><div class="pm-wrap"><ol class="pm-list">${list}</ol>
      <div class="pm-map"><div class="pl-live" id="pl-live"><p class="note">在打开地图…</p></div><p class="note">地图是高德的，能拖、能缩放。只画停留的地方，虚线只表示先后；认定是哪家、改地点在「停留」里。</p></div></div>`;
  }
  return `<p class="ptl-sum">${sum}</p><ol class="ptl" id="ptl">${rows}</ol>`;
}

/** 地点 · 常去：最近 30 天按地方合计。起过名的（家、公司……，可改名字、地址、种类、范围、删），常去但没起名的（去过 5 次以上，可起名），
 *  底下「添加一个地方」搜着加。不跟着翻日期，总是最近 30 天 */
function oftenView(st) {
  if (!st) return emptyInline("没取到常去的地方。");
  const md = (d) => (d ? d.slice(5) : "");
  const meta = (r) => [r.count ? `${r.count} 次` : "最近没来过", r.sec ? `共 ${spanText(r.sec)}` : "", r.last ? `最近 ${md(r.last)}` : ""].filter(Boolean).join(" · ");
  // 按「城市 › 区县」分组；起过名但最近没去过的（不知道在哪个区）放最后一组
  const groups = new Map();
  const put = (k, html, sec) => { if (!groups.has(k)) groups.set(k, { rows: [], sec: 0 }); const g = groups.get(k); g.rows.push(html); g.sec += sec; };
  for (const r of st.named) {
    const k = r.city || r.district ? [cityShort(r.city), r.district].filter(Boolean).join(" › ") : "最近没去过";
    put(k, `<li class="pf-row"><span class="pf-k">${esc(PL_ICON[r.type] || "其他")}</span>
      <span class="pf-b"><span class="pf-n">${esc(r.name)}${r.address ? `<span class="pf-a"> · ${esc(r.address)}</span>` : ""}</span><span class="pf-m">${esc(meta(r))} · 范围 ${Math.round(r.r || 150)} 米</span></span>
      <button class="mx-btn mx-btn--text mx-btn--sm" data-pl="${r.index}">改</button></li>`, r.sec || 0);
  }
  st.frequent.forEach((r, i) => put([cityShort(r.city), r.district].filter(Boolean).join(" › ") || "其他", `<li class="pf-row"><span class="pf-k often">常去</span>
      <span class="pf-b"><span class="pf-n">${esc(r.name)}</span><span class="pf-m">${esc(meta(r))} · 还没起名</span></span>
      <button class="mx-btn mx-btn--text mx-btn--sm" data-name-it="${i}">起名</button></li>`, r.sec || 0));
  const order = [...groups].sort((a, b) => (a[0] === "最近没去过") - (b[0] === "最近没去过") || b[1].sec - a[1].sec);
  return `<p class="ptl-sum">最近 ${st.days} 天 · 起过名的 ${st.named.length} 个 · 常去没起名的 ${st.frequent.length} 个</p>
    ${order.map(([k, g]) => section(k, `<ol class="pf-list">${g.rows.join("")}</ol>`)).join("") || emptyInline("还没有常去的地方")}
    <p class="note">按城市 › 区分组。没起名的列最近 ${st.days} 天去过 5 次以上的区域。</p>
    <div class="inline" style="margin-top:var(--space-4)"><button class="mx-btn mx-btn--secondary" id="pl-add">添加一个地方</button></div>`;
}

function bindOften() {
  $app.querySelectorAll(".pf-list [data-pl]").forEach((b) => (b.onclick = () => labelDialog(+b.dataset.pl)));
  $app.querySelectorAll("[data-name-it]").forEach((b) => (b.onclick = () => {
    const r = PL.stats.frequent[+b.dataset.nameIt];
    placeDialog({ lat: r.lat, lon: r.lon, name: `${r.district || ""} · ${r.name}`, label: null, type: "other" });
  }));
  const add = document.getElementById("pl-add");
  if (add) add.onclick = addPlaceDialog;
}

/** 全面页的「地点」：按地点合计的条形图（加上路上、没记到），明细在地点页签；不放跳转按钮 */
function placeTotals(visits, date) {
  if (!visits.length) return "";
  const tot = new Map();
  let go = 0, none = 0;
  for (const b of placeBlocks(visits, date)) {
    const sec = (b.z - b.a) / 1000;
    if (b.kind === "go") go += sec;
    else if (b.kind === "none") none += sec;
    else { const n = placeKey(b.v); tot.set(n, (tot.get(n) || 0) + sec); }
  }
  const tones = placeTones(visits, date);
  const rows = [...tot].sort((a, b) => b[1] - a[1]).map(([n, sec]) => ({ n, sec, c: "pl", tone: tones.get(n) }));
  if (go) rows.push({ n: "路上", sec: go, c: "go" });
  if (none) rows.push({ n: "没记到", sec: none, c: "none" });
  const max = Math.max(...rows.map((r) => r.sec), 1), all = rows.reduce((a, r) => a + r.sec, 0) || 1;
  const pct = (sec) => { const p = (sec / all) * 100; return p < 1 ? "<1%" : Math.round(p) + "%"; };
  const bars = `<div class="bars pl-bars">${rows.map((r) => `<div class="bar-row"><span class="bar-name${r.c === "pl" ? "" : " dim"}" title="${esc(r.n)}">${esc(r.n)}</span><span class="bar"><i class="${r.c}" style="width:${Math.max(2, Math.round((r.sec / max) * 100))}%${r.tone ? `;background:var(--pl-${r.tone})` : ""}"></i></span><span class="bar-v mono">${r.sec < 3600 ? Math.round(r.sec / 60) + "m" : hh(r.sec) + "h"}</span><span class="bar-p mono">${pct(r.sec)}</span></div>`).join("")}</div>`;
  return section("地点", bars);
}

/** 时间线上的一段停留 */
function stayItem(v, i, convs) {
  const dur = spanText((visitEnd(v) - Date.parse(v.start)) / 1000);
  const meta = [visitSpan(v), dur];
  if (!v.label && v.doing && v.doing.p >= 0.5 && !["picked", "phone"].includes(v.confirmed)) meta.push(v.doing.kind);
  // 自动写上的也标把握（第一名的）
  const topP = (v.guesses || [])[0] ? ` ${pctText(v.guesses[0].p)}` : "";
  if (v.confirmed === "auto") meta.push(`自动认出${topP}`);
  if (v.confirmed === "remembered") meta.push(`按上次认定${topP}`);
  const ok = v.confirmed === "picked" || v.confirmed === "phone";
  const pct = (g) => `${shopShort(g.name)}：把握 ${pctText(g.p)}，离记到的位置 ${Math.round(g.distance)} 米`;
  // 还没认定：名字后面淡色写最可能的一家和把握
  const top = !v.label && !v.confirmed && (v.guesses || [])[0];
  const likely = top ? `<span class="ptl-likely">· 可能是 ${esc(shopShort(top.name))} <span class="p">${pctText(top.p)}</span></span>` : "";
  // 候选：一段停留可以认定好几家（商场里逛了几家），点一下加上（打 ✓），再点取消。认定过的排前面，再补最像的凑满 3 个；
  // 一家没认定时问「是哪家？」，认定过的问「还去了？」。在手机上认定的不在这里列（改在 ⋯ 里）
  const shops = v.confirmed === "picked" ? (v.shops || []) : [];
  const chips = [...shops.map((n) => (v.guesses || []).find((g) => g.name === n) || { name: n }), ...(v.guesses || []).filter((g) => !shops.includes(g.name))].slice(0, Math.max(3, shops.length + 1));
  const guess = !v.label && v.confirmed !== "phone" && chips.length
    ? `<div class="ptl-guess">${shops.length ? "还去了？" : "是哪家？"}${chips.map((g) => { const on = shops.includes(g.name); return `<button class="${on ? "on" : ""}" data-chip="${i}" data-shop="${esc(g.name)}" aria-pressed="${on}" title="${esc(on ? `${shopShort(g.name)}：认定过，再点取消` : g.p != null ? pct(g) : shopShort(g.name))}">${on ? ICON.check : ""}${esc(shopShort(g.name))}${g.p != null ? `<span class="p">${pctText(g.p)}</span>` : ""}</button>`; }).join("")}<button class="other" data-edit="${i}">其他…</button></div>` : "";
  const talk = convs.length ? `<details class="ptl-talk"><summary>说话 ${convs.length} 段 · ${talkText(convs.reduce((a, c) => a + (c.talk || []).reduce((x, t) => x + t.sec, 0), 0))}</summary><div class="tl">${convs.map((c) => convRow(c, "", `<span class="t">${hm(c.start)}</span>`)).join("")}</div></details>` : "";
  return `<li class="ptl-stay${v.end ? "" : " now"}" data-sel="${i}"><span class="ptl-t mono">${v.arrive_known === false && v.arrive ? "昨天" : hm(v.start)}</span><span class="ptl-dot">${MARKS[Math.min(i, MARKS.length - 1)]}</span>
    <div class="ptl-b"><div class="ptl-name"><span title="${esc(chainOf(v))}">${esc(placeName(v))}</span>${likely}${badgeHtml(v)}${ok ? `<span class="ok" title="${v.confirmed === "phone" ? "在手机上认定的" : "你认定的"}">${ICON.check}</span>` : ""}</div>
      <div class="ptl-meta">${esc(meta.join(" · "))}</div>${guess}${talk}</div>
    <div class="ptl-act"><button class="mx-iconbtn" data-edit="${i}" aria-label="改地点" title="改地点">${ICON.more}</button></div></li>`;
}

/** 点候选：加上这家（打 ✓）；已认定的再点＝取消这家 */
async function pickChip(visits, i, name) {
  const v = visits[i];
  if (!v || !name) return;
  const g = (v.guesses || []).find((x) => x.name === name) || {};
  await call("set_place_pick", { id: v.id, shop: name, kind: g.type || null, lat: v.lat, lon: v.lon });
  renderToday();
}

/** 改地点（挂在那一行下面的小弹窗）：搜索框在最上面；下面是认定的、最像的几家（电脑算的，按把握排）和高德附近 150 米的地点（按距离），
 *  点一个就加上（再点认定过的＝取消这家）；搜不到的直接输入店名；最下面给这里起名、认定过的能退回只写区域 */
function placeEditor(v, anchor) {
  closeEditor();
  const box = document.createElement("div");
  box.className = "mx-menu ptl-edit"; box.setAttribute("role", "menu");
  const cands = new Map();
  // 认定过的打 ✓，点一下取消；没认定的点一下加上（一段停留可以认定好几家）
  const shops = v.confirmed === "picked" ? (v.shops || []) : [];
  const row = (p, key, right) => { cands.set(key, p); const on = shops.includes(p.name); return `<button role="menuitemcheckbox" aria-checked="${on}" class="${on ? "on" : ""}" data-pk="${esc(key)}"><span class="pk-n">${esc(shopShort(p.name))}<span class="pk-t">${esc(((p.type || "").split(";")[1]) || (p.type || "").split(";")[0] || "")}</span></span>${on ? `<span class="mx-check">${ICON.check}</span>` : `<span class="mx-menu-val">${right}</span>`}</button>`; };
  const extra = shops.filter((n) => !(v.guesses || []).some((g) => g.name === n)).map((n, j) => row({ name: n }, "x" + j, "")).join("");
  const guesses = (v.guesses || []).map((g, j) => row(g, "g" + j, `${Math.round(g.distance)} 米`)).join("");
  box.innerHTML = `${chainOf(v) ? `<div class="pe-chain">${esc(chainOf(v))}</div>` : ""}<input class="mx-input" id="pe-q" placeholder="搜店名，或直接输入" autocomplete="off">
    <div id="pe-found"></div>
    ${extra ? `<div class="mx-menu-group">认定的</div>${extra}` : ""}
    ${guesses ? `<div class="mx-menu-group">最像的</div>${guesses}` : ""}
    <div class="mx-menu-group">附近</div><div id="pe-near"><p class="note pe-wait">在问高德…</p></div>
    <hr><button role="menuitem" data-pe="label">${v.label ? "改这里的名字…" : "给这里起名…"}</button>
    ${shops.length ? `<button role="menuitem" data-pe="clear">${shops.length > 1 ? `都不确定，${shops.length} 家全撤销` : "不确定，退回只写区域"}</button>` : ""}`;
  anchor.appendChild(box);
  EDITOR = box;
  const choose = async (key) => {
    const c = key.startsWith("t:") ? { name: key.slice(2) } : cands.get(key);
    if (!c) return;
    await call("set_place_pick", { id: v.id, shop: c.name, kind: c.type || null, lat: c.lat ?? v.lat, lon: c.lon ?? v.lon });
    closeEditor(); renderToday();
  };
  box.addEventListener("click", async (e) => {
    e.stopPropagation();
    const b = e.target.closest("[data-pk]"); if (b) return choose(b.dataset.pk);
    const a = e.target.closest("[data-pe]"); if (!a) return;
    if (a.dataset.pe === "label") { closeEditor(); placeDialog(v); }
    if (a.dataset.pe === "clear") { await call("clear_place_pick", { id: v.id }); closeEditor(); renderToday(); }
  });
  const q = box.querySelector("#pe-q"); q.focus();
  let timer = null;
  q.oninput = () => {
    clearTimeout(timer);
    const t = q.value.trim(), out = box.querySelector("#pe-found");
    if (!t) { out.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      const found = await call("amap_search", { text: t, lat: v.lat, lon: v.lon }).catch(() => []);
      if (q.value.trim() !== t) return;
      out.innerHTML = found.filter((p) => (p.distance || 0) <= 500).slice(0, 4).map((p) => row(p, "s:" + p.id, `${Math.round(p.distance || 0)} 米`)).join("")
        + `<button role="menuitem" data-pk="t:${esc(t)}">就叫「${esc(t)}」</button><hr>`;
    }, 350);
  };
  q.onkeydown = (e) => { if (e.key === "Escape") closeEditor(); if (e.key === "Enter" && !e.isComposing && q.value.trim()) choose("t:" + q.value.trim()); };
  call("amap_around", { lat: v.lat, lon: v.lon, radius: 150 })
    .then((near) => { const el = box.querySelector("#pe-near"); if (el) el.innerHTML = near.filter((p) => !(v.guesses || []).some((g) => g.name === p.name)).slice(0, 6).map((p) => row(p, "n:" + p.id, `${Math.round(p.distance || 0)} 米`)).join("") || `<p class="note pe-wait">附近 150 米没有地点。</p>`; })
    .catch((x) => { const el = box.querySelector("#pe-near"); if (el) el.innerHTML = `<p class="note pe-wait">${esc(String(x))}</p>`; });
}
let EDITOR = null;
function closeEditor() { if (EDITOR) { EDITOR.remove(); EDITOR = null; } }
document.addEventListener("click", (e) => { if (EDITOR && !EDITOR.contains(e.target) && !e.target.closest("[data-edit]")) closeEditor(); });

/** 给一个地方起名（小弹层）：名字＋种类，存进本机的地点名单；清空＝删掉这个名字 */
function placeDialog(v) {
  const TYPES = [["home", "家"], ["work", "工作"], ["other", "其他"]];
  let kind = v.type || "other";
  openDialog({
    title: v.label ? `改「${v.label}」的名字` : `给「${placeName(v)}」起名`, ok: "保存",
    body: dlgField("pl-name", "名字", { value: v.label || "", ph: "比如 家、公司、健身房", help: v.label ? "清空就删掉这个名字" : `地图上查到的地名是「${esc(v.name || "没有")}」。` })
      + `<div class="mx-field"><label>种类</label><div class="mx-seg" role="tablist" id="pl-kind">${TYPES.map(([k, t]) => `<button role="tab" aria-selected="${k === kind}" class="${k === kind ? "is-on" : ""}" data-v="${k}">${t}</button>`).join("")}</div></div>`,
    onOpen: (el) => {
      el.querySelector("#pl-name").maxLength = 20;
      el.querySelector("#pl-kind").onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        kind = b.dataset.v;
        el.querySelectorAll("#pl-kind button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); });
      };
    },
    submit: async (el) => { await call("set_place_label", { lat: v.lat, lon: v.lon, label: dlgVal(el, "pl-name"), kind }); renderToday(); },
  });
}

function actogram(rows, cur) {
  let html = "";
  for (const [k, x] of rows.entries()) {
    // 行末：这一晚的分钟数＝当天 21 点以后＋次日 0–5 点（次日没有数据就只算当天）
    const nx = rows[k + 1] || x.next;
    let late = nx ? [0, 1, 2, 3, 4].reduce((a, h) => a + Math.max(nx.hc[h], nx.hp[h]), 0) : 0;
    html += x.has ? `<a class="d${x.date === cur ? " cur" : ""}" href="#/summary/${x.date}">${short(x.date)}</a>` : `<span class="d">${short(x.date)}</span>`;
    for (let h = 0; h < 24; h++) {
      const c = x.hc[h], p = x.hp[h];
      if (h >= 21) late += Math.max(c, p);
      html += `<div class="cell${isNight(h) && (c || p) ? " n" : ""}" title="${short(x.date)} ${h}:00 电脑 ${c} 分钟 · 手机 ${p} 分钟"><span style="${shade(c, "--rec-computer")}"></span><span style="${shade(p, "--rec-phone")}"></span></div>`;
    }
    html += `<span class="late">${late > 10 ? late + "m" : ""}</span>`;
  }
  const axis = Array.from({ length: 8 }, (_, i) => `<span style="grid-column:${2 + i * 3}">${i * 3}</span>`).join("");
  return `<div role="img" aria-label="最近 ${rows.length} 天作息图"><div class="acto">${html}</div><div class="acto-axis" aria-hidden="true">${axis}</div></div>
    <div class="legend"><span><i style="background:var(--rec-computer)"></i>电脑</span><span><i style="background:var(--rec-phone)"></i>手机</span><span><i style="background:var(--rec-night)"></i>熬夜分钟（21:00–5:00）</span></div>`;
}

// ---------- 状态 ----------

const S = { days: [], status: null, page: "today", rules: null, settings: null, draft: null, modelReady: null };

async function boot() {
  [S.days, S.status, S.sync, S.profile] = await Promise.all([call("list_days"), call("get_status"), call("sync_status").catch(() => ({})), call("get_profile").catch(() => ({ name: "我" }))]);
  S.modelReady = await call("model_ready").catch(() => null);
  S.bannerOff = false;
  renderSide();
  loadUpdate();
  setInterval(loadUpdate, 10 * 60 * 1000);
}

function renderSide() {
  // 侧栏只放导航；记录状态在「设备」页，这里只在缺权限、暂停、没在记录时给「设备」挂一个点
  const st = S.status || {};
  const perm = st.permissions || {};
  // 手机版不采集，没有权限、暂停这些
  const bad = !st.mobile && (st.paused || !perm.accessibility || !perm.input_monitoring || !st.capturing);
  const dot = document.getElementById("dev-dot");
  if (dot) { dot.hidden = !bad; dot.title = st.paused ? "已暂停" : "没在记录或缺权限"; }
  const pf = S.profile || { name: "我" };
  const av = document.getElementById("me-avatar");
  if (av) av.innerHTML = avatarHtml(pf);
  const nm = document.getElementById("me-name");
  if (nm) nm.textContent = pf.name || "我";
  const sub = document.getElementById("me-sub");
  // 正常记录时不写；暂停、缺权限、没在记录才提示
  if (sub) sub.textContent = st.mobile ? "" : st.paused ? " · 已暂停" : !perm.accessibility || !perm.input_monitoring ? " · 缺权限" : st.capturing ? "" : " · 没在记录";
  renderMeMenu();
}

/** 头像：有图片用图片，没有用名字第一个字 */
const avatarHtml = (pf) => (pf && pf.avatar ? `<img src="${esc(pf.avatar)}" alt="">` : esc(((pf && pf.name) || "我").trim().slice(0, 1).toUpperCase()));

// ---------- 左下角菜单（照 Claude） ----------

// 图标：Lucide（ISC 许可，见 app/THIRD_PARTY_NOTICES.md），24 格画布、细线
const lu = (paths) => `<svg class="mx-ico lu" viewBox="0 0 24 24">${paths}</svg>`;
const MI = {
  gear: lu('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  pause: lu('<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>'),
  play: lu('<path d="M6 3l14 9-14 9z"/>'),
  devices: lu('<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 19v-3.96 3.15"/><path d="M7 19h5"/><rect width="6" height="10" x="16" y="12" rx="2"/>'),
  folder: lu('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  info: lu('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  update: lu('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  quit: lu('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
};

// ---------- 自动更新：后台下好了，菜单和设置里出「重启更新」 ----------

/** 左下角菜单里的一行：下好了可以点；还在下就只显示 */
function updateItem() {
  const u = S.update || {};
  if (!u.newer || u.updatable) return "";
  return u.ready ? `<button role="menuitem" data-me="update">${MI.update}重启更新到 ${esc(u.latest)}</button>` : `<button role="menuitem" disabled>${MI.update}正在下载 ${esc(u.latest)}</button>`;
}

async function loadUpdate() {
  if (!TAURI) return;
  try { S.update = await call("update_status"); renderSide(); } catch (e) {}
}

async function applyUpdate() {
  try { await call("update_apply"); } catch (x) { alert(`没更新成功：${x}`); }
}

function aboutSection() {
  const u = S.update || {}, st = S.status || {};
  const state = u.checking ? "正在检查…" : u.updatable ? u.updatable : u.error ? u.error
    : u.newer ? (u.ready ? `${u.latest} 已经下好，重启就能用。` : `正在下载 ${u.latest}…`)
    : u.checked ? `已是最新版本（${mdhm(u.checked)} 检查过）` : "会自动检查更新";
  const btn = u.newer && u.ready && !u.updatable ? `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="up-go">重启更新</button>` : `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="up-check" ${u.checking ? "disabled" : ""}>检查更新</button>`;
  return section("关于", `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">版本 ${esc(u.current || st.version || "")}</div><div class="mx-setting-desc">${esc(state)}</div>${u.newer && u.notes ? `<div class="mx-setting-desc">${esc(u.notes)}</div>` : ""}</div>${TAURI ? btn : ""}</div>`);
}

function bindAbout() {
  const c = document.getElementById("up-check");
  if (c) c.onclick = async () => { S.update = { ...(S.update || {}), checking: true }; renderSettings(); try { S.update = await call("update_check"); } catch (x) {} renderSide(); renderSettings(); };
  const g = document.getElementById("up-go");
  if (g) g.onclick = applyUpdate;
}

function renderMeMenu() {
  const menu = document.getElementById("me-menu");
  if (!menu) return;
  const st = S.status || {};
  menu.innerHTML = `<div class="mx-menu-group">${esc((S.sync && S.sync.email) || (st.device || "").replace(/^mac-/, "Mac · "))}</div>
    <button role="menuitem" data-me="settings">${MI.gear}设置<span class="mx-menu-val">⌘,</span></button>
    ${st.paused
      ? `<button role="menuitem" data-me="resume">${MI.play}继续记录${st.paused_until ? `<span class="mx-menu-val">${hm(st.paused_until)} 自动继续</span>` : ""}</button>`
      : `<button role="menuitem" data-me="pause">${MI.pause}暂停记录 1 小时</button>`}
    <button role="menuitem" data-me="devices">${MI.devices}设备与同步</button>
    <button role="menuitem" data-me="data">${MI.folder}打开数据目录</button>
    <hr>
    ${updateItem()}<button role="menuitem" disabled>${MI.info}版本<span class="mx-menu-val">${esc(st.version || "")}</span></button>
    <hr>
    <button role="menuitem" data-me="quit">${MI.quit}退出 Beayy</button>`;
}

function toggleMe(open) {
  const menu = document.getElementById("me-menu"), btn = document.getElementById("me");
  if (!menu) return;
  menu.hidden = open === undefined ? !menu.hidden : !open;
  btn.setAttribute("aria-expanded", String(!menu.hidden));
}

/** 手机（窄屏、iPhone 版）：左下角菜单变成底部页签里的「我」，点了直接进设置 */
const NARROW = window.matchMedia("(max-width: 760px)");
document.getElementById("me").onclick = (e) => { e.stopPropagation(); if (NARROW.matches) { location.hash = "#/settings"; return; } toggleMe(); };
document.getElementById("me-menu").onclick = async (e) => {
  const b = e.target.closest("[data-me]"); if (!b) return;
  toggleMe(false);
  const k = b.dataset.me;
  if (k === "settings") location.hash = "#/settings";
  else if (k === "devices") location.hash = "#/devices";
  else if (k === "data") call("open_data_dir");
  else if (k === "quit") call("quit_app");
  else if (k === "update") applyUpdate();
  else { await call("set_paused", k === "pause" ? { paused: true, minutes: 60 } : { paused: false }); S.status = await call("get_status"); renderSide(); if (S.page === "settings" || S.page === "devices") route(); }
};
document.addEventListener("click", (e) => { if (!e.target.closest(".me-wrap")) toggleMe(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleMe(false);
  if (e.metaKey && e.key === ",") { e.preventDefault(); location.hash = "#/settings"; }
});

function markNav(page) {
  document.querySelectorAll("#nav a, .me").forEach((a) => a.classList.toggle("is-on", a.dataset.page === page));
}

// ---------- 今天 ----------

/** 「今天」页页签那一行右边的翻日期：一个整体「‹ 日期 ▾ ›」（点日期展开，只列有数据的日子，同总结页）；
 *  看以前的日子时左边多一个「今天」，同样高度 */
function dayPicker(date, past) {
  const now = localDay();
  const dates = [...new Set([now, ...S.days.map((x) => x.date)])].sort().reverse();
  const i = dates.indexOf(date), prev = dates[i + 1], next = i > 0 ? dates[i - 1] : null;
  return `${past ? `<button class="mx-btn mx-btn--secondary dn-today" data-day="${now}">今天</button>` : ""}
    <div class="daynav pick">
      <button class="dn-step" aria-label="前一天" title="前一天" ${prev ? `data-day="${prev}"` : "disabled"}>${ICON.chevL}</button>
      <button class="dn-date" id="day-pick" aria-haspopup="menu" aria-expanded="false">${short(date)}${ICON.chevD}</button>
      <button class="dn-step" aria-label="后一天" title="后一天" ${next ? `data-day="${next}"` : "disabled"}>${ICON.chevR}</button>
      <div class="mx-menu" role="menu" hidden>${dates.map((x) => `<button role="menuitemradio" aria-checked="${x === date}" data-day="${x}">${x === now ? "今天" : short(x)}${x === date ? `<span class="mx-check">${ICON.check}</span>` : ""}</button>`).join("")}</div></div>`;
}
const goDay = (x) => { location.hash = x && x !== localDay() ? `#/today/${x}` : "#/today"; };

/** 「今天」页看的是哪一天：null＝今天；地址 #/today/YYYY-MM-DD 看以前的日子（概览、时间线、分类切来切去都停在这天） */
const TD = { date: null };
const isPastDay = () => TD.date && TD.date !== localDay();

async function renderToday() {
  const today = isPastDay() ? TD.date : localDay(), past = today !== localDay();
  // 今天总有实时数据（电脑来自自采事件，手机来自 iPhone 同步），不再等每晚的数据包；以前的日子按日期取
  const d = (await call("get_day", { date: today })) || { date: today };
  const pack = d.pack || {}, c = d.live || pack.computer || {}, ph = d.phone;
  const fda = ((S.status || {}).permissions || {}).full_disk_access;
  const hc = hourMinutes(c.active_hours || {});
  const hp = hourMinutes(ph ? ph.hours : (pack.phone || {}).hours);
  const phoneLag = ANDROID ? "Android 数据由 Beayy 在本机采集；开启无障碍和使用情况访问后，会记录 app 时长与界面摘要。" : "iPhone 的屏幕使用时间由苹果经 iCloud 传到这台 Mac，常晚几个小时。iPhone 和 Mac 都要打开「屏幕使用时间 → 在设备间共享」。";
  const phoneStale = ph && !past && Date.now() - Date.parse(ph.synced_until) > 3 * 3600e3;
  const phoneCap = ph ? (past ? (ph.pickups != null ? `拿起 ${ph.pickups} 次` : "") : `同步至 ${ymdhm(ph.synced_until)}${phoneStale ? `\n${phoneLag}` : ""}`)
    : ANDROID ? `还没有 Android 手机数据\n${phoneLag}` : fda === false ? "未授权完全磁盘访问" : past ? "取不到" : `今天还没有手机数据\n${phoneLag}`;
  const sp = d.speech, visits = (d.places && d.places.visits) || [];
  // 说话按分钟画，不满 1 分钟的也算 1 分钟，免得零碎的几句看不见
  const hw = sp ? Array.from({ length: 24 }, (_, i) => Math.min(60, Math.ceil(((sp.hours || {})[pad2(i)] || 0) / 60))) : null;
  const items = timelineItems(d);
  const counts = { all: items.length, computer: items.filter((x) => x.dev === "computer").length, phone: items.filter((x) => x.dev === "phone" && !x.visit).length };
  if (sp) counts.watch = items.filter((x) => x.dev === "watch").length;
  const tab = TL.tab in counts ? TL.tab : "all";
  const shown = items.filter((x) => tab === "all" || x.dev === tab);
  // 照 Claude：标题下一行，左边「概览｜时间线」纯文字页签；时间线后面接「全部／电脑／手机」切换块；右边放同步时刻
  // 三个页签：全面（面：这一天的汇总看板）、时间线（线：按小时）、地点（点：按停留，去了哪、认定是哪家）
  const view = TL.view === "timeline" ? "timeline" : ["places", "map"].includes(TL.view) ? "places" : "overview";
  const pview = ["map", "often"].includes(TL.pview) ? TL.pview : "stays";
  const pseg = `<div class="mx-seg" role="tablist" id="pl-tabs">${[["stays", "停留"], ["map", "地图"], ["often", "常去"]].map(([k, v]) =>
    `<button role="tab" aria-selected="${k === pview}" class="${k === pview ? "is-on" : ""}" data-pv="${k}">${v}</button>`).join("")}</div>`;
  const seg = `<div class="mx-seg" role="tablist" id="tl-tabs">${[["all", "全部"], ["computer", "电脑"], ["phone", "手机"], ["watch", "手表"]].filter(([k]) => k in counts).map(([k, v]) =>
    `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? "is-on" : ""}" data-tab="${k}">${v}<span class="n">${counts[k]}</span></button>`).join("")}</div>`;
  const toolbar = `<div class="toolbar"><div class="toolbar-left"><div class="tabs" role="tablist" id="view-tabs">${[["overview", "全面"], ["timeline", "时间线"], ["places", "地点"]].map(([k, v]) =>
      `<button role="tab" aria-selected="${k === view}" class="${k === view ? "is-on" : ""}" data-view="${k}">${v}</button>`).join("")}</div>
    <div class="toolbar-right">${ph && !past ? (phoneStale ? `<span class="note tb-note" title="${esc(phoneLag)}">${ANDROID ? `手机记录停在 ${hm(ph.synced_until)}` : `手机停在 ${hm(ph.synced_until)}，在等苹果传来`}</span>` : `<span class="note tb-note">同步至 ${ymdhm(ph.synced_until)}</span>`) : ""}${view === "places" && pview === "often" ? "" : dayPicker(today, past)}</div></div>`;
  const overview = `<div class="readouts">
        ${readout("在电脑前", hh(c.active_sec), "h", c.first ? `${c.first}–${c.last}` : "还没有记录")}
        ${readout("手机", ph || fda !== false ? hh(ph ? ph.total_sec : (pack.phone || {}).total_sec) : "—", "h", phoneCap)}
        ${sp ? readout("说话", sp.talk_sec < 3600 ? mins(sp.talk_sec) : hh(sp.talk_sec), sp.talk_sec < 3600 ? "分钟" : "h", sp.first ? `录音 ${hm(sp.first)}–${hm(sp.last)}` : past ? "这一天没有录音" : "今天还没有录音") : ""}
        ${readout("切换", c.switches ?? "—", "次", "应用之间切换")}
        ${visits.length ? readout("去了", new Set(visits.map((v) => v.label || placeName(v).split(" · ")[0])).size, "处", `${visits.length} 段停留`) : ""}
      </div>`
    + section("手机记录", ANDROID
      ? `Android 在本机采集 app 使用时长、界面文字、通知、电量和网络状态。${howto("phone_recording", "查看 Android 设置")}`
      : `iPhone 的屏幕使用时间经 iCloud 同步到 Mac，可能延迟数小时。${howto("screentime", "查看 iPhone 设置")}`)
    + `<div class="secs-plain" style="margin-top:var(--space-6)">`
    + recentDays(today, { c: c.active_sec, p: ph ? ph.total_sec : (pack.phone || {}).total_sec })
    + section("一天", dayStrip(hc, hp, true, { hw, visits, date: today }) + `<div class="legend"><span><i style="background:var(--rec-computer)"></i>电脑</span><span><i style="background:var(--rec-phone)"></i>手机</span>${sp ? `<span><i style="background:var(--rec-watch)"></i>说话</span>` : ""}${visits.length ? `<span><i style="background:var(--rec-go)"></i>路上</span>` : ""}</div>`)
    + placeTotals(visits, today)
    + workSection(d.work) + `</div>`;
  if (view === "places" && (pview === "often" || !PL.stats || Date.now() - (PL.at || 0) > 600e3)) {
    [PL.stats, PL.labels] = await Promise.all([call("place_stats", { days: 30 }).catch(() => null), call("list_place_labels").catch(() => [])]);
    PL.at = Date.now();
  }
  const placesView = pview === "often" ? oftenView(PL.stats) : visits.length ? placesSection(visits, today, sp && sp.conversations, pview)
    : emptyInline(past ? "这一天没有停留点" : "今天还没有停留点");

  // 手机独有的信号（通知、媒体、电量、网络）：Android 采的，桌面和 iOS 没有。
  // 只在「手机」页签下显示，避免把时间线搅乱。
  const extra = tab === "phone" ? phoneExtraBlock(d.phone_extra) : "";
  const timeline = shown.length ? `<div class="tl" id="tl">${tab === "all" ? hourRows(d, items) : tab === "phone" && visits.length ? phoneByPlace(shown, visits, today) : shown.map(tlRow).join("")}</div>`
    : past ? emptyInline(tab === "phone" ? "这一天没有手机记录" : tab === "watch" ? "这一天没有对话" : "这一天没有记录")
    : tab === "phone" ? `<p class="mx-empty-inline">${ANDROID ? `Android 手机记录还没有数据 · ${howto("phone_recording", "查看 Android 设置")}` : `iPhone 记录还没有同步 · ${howto("screentime", "查看 iPhone 设置")}`}</p>`
    : emptyInline(tab === "watch" ? "今天还没有对话" : "今天还没有记录");
  // 照 Claude 自定义页：标题单独一行；页签和右边的控件（同步时刻、翻日期）同一行
  $app.innerHTML = modelBanner() + header(past ? short(today) : "今天") + toolbar
    + `<div class="reading">${view === "timeline" ? timeline + extra : view === "places" ? placesView : overview}</div>`;
  bindModelBanner();
  // 地图视图铺满窗口（不受阅读宽度限制）
  $app.classList.toggle("wide", view === "places" && pview === "map");
  if (view === "places" && pview === "map" && visits.length) drawLiveMap(visits, today, PL_SEL.date === today ? PL_SEL.i : null);
  bindOften();
  const plTabs = document.getElementById("pl-tabs");
  if (plTabs) plTabs.onclick = (e) => {
    const b = e.target.closest("[data-pv]"); if (!b) return;
    TL.pview = b.dataset.pv;
    try { localStorage.setItem("place-view", TL.pview); } catch (err) {}
    renderToday();
  };

  document.getElementById("view-tabs").onclick = (e) => {
    const b = e.target.closest("[data-view]"); if (!b) return;
    TL.view = b.dataset.view;
    try { localStorage.setItem("today-view", TL.view); } catch (err) {}
    renderToday();
  };
  const tlTabs = document.getElementById("tl-tabs");
  if (tlTabs) tlTabs.onclick = (e) => {
    const b = e.target.closest("[data-tab]"); if (!b) return;
    TL.tab = b.dataset.tab;
    try { localStorage.setItem("tl-tab", TL.tab); } catch (err) {}
    renderToday();
  };
  bindPick(document.getElementById("day-pick"));
  $app.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => goDay(b.dataset.day)));
  $app.querySelectorAll("[data-chip]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); pickChip(visits, +b.dataset.chip, b.dataset.shop); }));
  $app.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const li = b.closest("li"); EDITOR && EDITOR.parentNode === li ? closeEditor() : placeEditor(visits[+b.dataset.edit], li); }));
  // 点一段停留：地图上那个点变成强调色，这一行高亮；再点取消
  $app.querySelectorAll("[data-sel]").forEach((li) => (li.onclick = (e) => {
    if (!li.classList.contains("pm-row") && e.target.closest("button, summary, details .tl, .ptl-edit")) return;
    if (!document.getElementById("pl-map") && !document.getElementById("pl-live")) return;
    const i = +li.dataset.sel, same = PL_SEL.date === today && PL_SEL.i === i;
    PL_SEL = same ? { date: null, i: null } : { date: today, i };
    $app.querySelectorAll("[data-sel]").forEach((x) => x.classList.toggle("is-sel", !same && +x.dataset.sel === i));
    LM.map ? liveSelect(same ? null : i, true) : drawPlaceMap(visits, same ? null : i);
  }));
  if (pview === "map" && PL_SEL.date === today && PL_SEL.i != null) { const li = $app.querySelector(`[data-sel="${PL_SEL.i}"]`); if (li) li.classList.add("is-sel"); }
  // 点一天的形状里的某个小时：切到时间线，滚到那个小时
  $app.querySelectorAll(".strip [data-h], .place-bar [data-h]").forEach((cell) => (cell.onclick = () => {
    TL.view = "timeline"; TL.jump = +cell.dataset.h;
    renderToday();
  }));
  if (view === "timeline" && TL.jump != null) {
    const h = TL.jump; TL.jump = null;
    const rows = [...$app.querySelectorAll("#tl > [data-h]")];
    const hit = rows.filter((r) => +r.dataset.h === h).pop() || rows.find((r) => +r.dataset.h < h);
    if (hit) {
      hit.scrollIntoView({ block: "center" });
      hit.classList.remove("flash"); void hit.offsetWidth; hit.classList.add("flash");
    }
  }
  loadIcons();
}

// ---------- 时间花在哪：按项目、按类型（10 分钟摘要里模型给的标签 × 在电脑前的秒数） ----------

/** 展开着的一级（「activities:创作」这样的键），记在本机，每分钟自动刷新后保持 */
const WORK_OPEN = new Set((() => { try { return JSON.parse(localStorage.getItem("work-open") || "[]"); } catch (e) { return []; } })());

function workSection(w) {
  if (!w || !((w.domains || []).length || (w.activities || []).length)) return "";
  const dur = (sec) => (sec < 3600 ? Math.round(sec / 60) + "m" : hh(sec) + "h");
  // 两级：一级一行，有二级的点整行展开（不画箭头）；条长按这一列最长的一级比，百分比按这一列合计算
  const tree = (kind, rows) => {
    const max = Math.max(...rows.map((r) => r.sec), 1), total = rows.reduce((a, r) => a + r.sec, 0) || 1;
    const pct = (sec) => { const p = (sec / total) * 100; return p < 1 ? "<1%" : Math.round(p) + "%"; };
    const cells = (r) => `<span class="bar-name${r.dim ? " dim" : ""}" title="${esc(r.name)}">${esc(r.name)}</span><span class="bar"><i style="width:${Math.max(2, Math.round((r.sec / max) * 100))}%"></i></span><span class="bar-v mono">${dur(r.sec)}</span><span class="bar-p mono">${pct(r.sec)}</span>`;
    return `<div class="bars">${rows.map((r) => {
      const kids = r.children.length > 1 || (r.children[0] && r.children[0].name !== r.name) ? r.children.slice(0, kind === "projects" ? undefined : 6) : [];
      if (!kids.length) return `<div class="bar-row">${cells(r)}</div>`;
      const k = `${kind}:${r.name}`, open = WORK_OPEN.has(k);
      return `<div class="bar-grp"><button class="bar-row top" data-work="${esc(k)}" aria-expanded="${open}">${cells(r)}</button>
        <div class="bar-kids"${open ? "" : " hidden"}>${kids.map((c) => `<div class="bar-row kid">${cells(c)}</div>`).join("")}</div></div>`;
    }).join("")}</div>`;
  };
  // 项目：不再先分领域，所有项目按时长排，占时间长的在前。没归到项目的工作时间叫「未归项目」、灰字放最后；
  // 别的领域（休闲、关系……）里没归到项目的按领域名算一行。项目这列的行数和类型那列一样（类型全列），
  // 放不下的合成「其他 N 个项目」，点开看是哪些（两列一样多）
  const pj = new Map();
  const add = (name, sec) => pj.set(name, (pj.get(name) || 0) + sec);
  for (const d of w.domains || []) {
    const named = d.children.filter((c) => c.name !== "未归项目");
    for (const c of named) add(c.name, c.sec);
    const rest = d.sec - named.reduce((a, c) => a + c.sec, 0);
    if (rest >= 30) add(d.name === "工作" ? "未归项目" : d.name, rest);
  }
  const projects = [...pj].filter(([n]) => n !== "未归项目").map(([name, sec]) => ({ name, sec, children: [] })).sort((a, b) => b.sec - a.sec);
  const slots = Math.max((w.activities || []).length, 3) - (pj.has("未归项目") ? 1 : 0);
  if (projects.length > slots) {
    const more = projects.splice(slots - 1);
    projects.push({ name: `其他 ${more.length} 个项目`, sec: more.reduce((a, r) => a + r.sec, 0), children: more, dim: true });
  }
  if (pj.has("未归项目")) projects.push({ name: "未归项目", sec: pj.get("未归项目"), children: [], dim: true });
  return section("时间", `<div class="work"><div><h4>项目</h4>${tree("projects", projects)}</div><div><h4>类型</h4>${tree("activities", w.activities || [])}</div></div>`);
}

// 展开／收起一级：直接改这一块，不重画整页
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-work]"); if (!b) return;
  const k = b.dataset.work, open = b.getAttribute("aria-expanded") !== "true";
  b.setAttribute("aria-expanded", open);
  b.nextElementSibling.hidden = !open;
  open ? WORK_OPEN.add(k) : WORK_OPEN.delete(k);
  try { localStorage.setItem("work-open", JSON.stringify([...WORK_OPEN])); } catch (x) {}
});

// ---------- 时间线：电脑的 10 分钟摘要和手机的每次拿起，按设备分页签，新的在上 ----------

/** 「全部」页签按小时：每小时一行（小时摘要＋项目＋电脑和手机用过的 app 图标＋手机用了多久），点开看这一小时的 10 分钟明细和每次拿起；
 *  连着的「不在电脑前、也没碰手机」的小时合成一行灰字 */
function hourRows(d, items) {
  const hourOf = (iso) => { const t = new Date(iso); t.setMinutes(0, 0, 0); return t.getTime(); };
  const roll = Object.fromEntries((d.hours || []).map((h) => [hourOf(h.start), h]));
  const buckets = new Map();
  const put = (k, x) => { if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(x); };
  for (const x of items) {
    if (x.dev === "computer" && x.seg.kind === "idle") continue; // 合并过的空段按小时摘要算
    if (x.visit) continue; // 停留点写在每小时行首
    if (x.conv) {
      // 对话按小时切开：每个小时只放这一小时里说的句子
      const by = new Map();
      for (const l of x.conv.lines || []) { const k = hourOf(l.start); if (!by.has(k)) by.set(k, []); by.get(k).push(l); }
      for (const [k, lines] of by) {
        const talk = {};
        for (const l of lines) talk[l.speaker] = (talk[l.speaker] || 0) + (Date.parse(l.end) - Date.parse(l.start)) / 1000;
        put(k, { dev: x.dev, start: lines[0].start, end: lines[lines.length - 1].end, conv: { lines, talk: Object.entries(talk).map(([speaker, sec]) => ({ speaker, sec: Math.round(sec) })) } });
      }
      continue;
    }
    put(hourOf(x.start), x);
  }
  const visits = (d.places && d.places.visits) || [];
  const talkH = (d.speech && d.speech.hours) || {};
  for (const k of Object.keys(roll)) if (!buckets.has(+k)) buckets.set(+k, []);
  const keys = [...buckets.keys()].sort((a, b) => b - a);
  const now = Date.now();
  const out = [];
  let idleRun = null; // 连着的空小时 [最早, 最晚]
  const flushIdle = () => { if (idleRun) { out.push(`<div class="tl-row computer idle" data-h="${new Date(idleRun[0]).getHours()}"><span class="t">${hm(new Date(idleRun[0]).toISOString())}–${hm(new Date(idleRun[1] + 3600e3).toISOString())}</span><span>不在电脑前</span></div>`); idleRun = null; } };
  for (const k of keys) {
    const xs = buckets.get(k), r = roll[k];
    const comp = xs.filter((x) => x.dev === "computer"), ph = xs.filter((x) => x.dev === "phone" && x.ses), wt = xs.filter((x) => x.conv);
    const idle = !comp.length && (!r || r.title === "不在电脑前") && k + 3600e3 <= now;
    if (idle && !ph.length && !wt.length) { idleRun = idleRun ? [k, idleRun[1]] : [k, k]; continue; }
    flushIdle();
    const phSec = ph.reduce((a, x) => a + x.ses.sec, 0);
    const phApps = {};
    for (const x of ph) for (const a of x.ses.apps) phApps[a.name] = (phApps[a.name] || 0) + a.sec;
    const topPh = Object.entries(phApps).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join("、");
    const latest = comp[0] && comp[0].seg;
    const title = r && r.title !== "不在电脑前" ? r.title : comp.length ? (k + 3600e3 > now ? `进行中：${latest.title}` : latest.title) : "不在电脑前";
    const desc = r && r.title !== "不在电脑前" ? r.description : comp.length && k + 3600e3 > now ? latest.description : "";
    // 项目：小时摘要里按秒累计好的，没有（进行中）就用这几段的
    const pj = {};
    for (const p of (r && r.parts) || []) if (p.project) pj[p.project] = (pj[p.project] || 0) + p.sec;
    if (!r) for (const x of comp) for (const p of x.seg.parts || []) if (p.project) pj[p.project] = (pj[p.project] || 0) + (x.seg.active_sec || 0) * p.share;
    const chips = Object.entries(pj).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, v]) => `<span class="mx-tag">${esc(n)} ${Math.round(v / 60)}m</span>`).join("");
    // 地点只在和上一个小时不一样时写（到了新地方），免得每小时都重复「公司」
    const here = placeAt(visits, k, k + 3600e3), before = placeAt(visits, k - 3600e3, k);
    const where = here && (!before || placeName(before) !== placeName(here)) ? placeName(here) : null;
    const talkSec = talkH[pad2(new Date(k).getHours())] || 0;
    const talkWho = {};
    for (const x of wt) for (const t of x.conv.talk) talkWho[t.speaker] = (talkWho[t.speaker] || 0) + t.sec;
    const who = speakers(Object.entries(talkWho).map(([speaker, sec]) => ({ speaker, sec })), SELF);
    const inner = xs.sort((a, b) => (a.start < b.start ? 1 : -1)).map(tlRow).join("");
    // 这一小时电脑、手机用过的 app 图标（按时间先后，各最多 10 个）
    const cApps = [...new Set([...comp].reverse().flatMap((x) => x.seg.apps || []))];
    const pNames = Object.fromEntries(ph.flatMap((x) => x.ses.apps.map((a) => [a.bundle_id, a.name])));
    const pApps = [...new Set([...ph].reverse().flatMap((x) => x.ses.apps.map((a) => a.bundle_id)))];
    const cIco = icons(cApps, false), pIco = icons(pApps, true, pNames);
    const appsLine = cIco || pIco ? `<div class="hour-apps">${cIco ? `<span class="lbl">电脑</span>${cIco}` : ""}${pIco ? `<span class="lbl">手机</span>${pIco}` : ""}</div>` : "";
    out.push(`<details class="tl-row hour" data-h="${new Date(k).getHours()}"><summary><span class="t">${hm(new Date(k).toISOString())}–${hm(new Date(k + 3600e3).toISOString())}${where ? `<div class="where" title="${esc(where)}">${esc(where)}</div>` : ""}</span><span>
        <span class="name${title === "不在电脑前" ? " dim" : ""}">${esc(title)}</span>${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
        ${chips ? `<div class="chips">${chips}</div>` : ""}${appsLine}${phSec ? `<div class="ph-line">手机 ${minText(phSec)}${topPh ? ` · ${esc(topPh)}` : ""}</div>` : ""}${wt.length ? `<div class="ph-line">对话 ${talkText(talkSec)} · ${esc(who.slice(0, 3).join("、"))}${who.length > 3 ? ` 等 ${who.length} 人` : ""}</div>` : ""}</span>
        ${inner ? `<span class="chev">${ICON.chevR}</span>` : "<span></span>"}</summary>${inner ? `<div class="hour-in">${inner}</div>` : ""}</details>`);
  }
  flushIdle();
  return out.join("");
}


/** 地点 · 地图：高德 JS API 2.0（Key 和安全密钥在钥匙串，amap_js_config 给页面）。停留点按先后编号、虚线连起来，
 *  常去的点深一点、新地方浅一点，选中的强调色；点点和点清单互相选中；同一天自动刷新时保留缩放和位置。加载不了退回静态图 */
const LM = { map: null, day: null, view: null, loading: null, markers: [], visits: [] };
function loadAmapJs() {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (LM.loading) return LM.loading;
  LM.loading = call("amap_js_config").then((c) => new Promise((ok, fail) => {
    if (!c || !c.key) return fail(new Error(c && c.error ? c.error : "还没有地图 Key（设置 → 连接 → 地图）"));
    // 官方：安全密钥留在服务器，地图经中转地址取；自己的：页面里带安全密钥
    window._AMapSecurityConfig = c.service_host ? { serviceHost: c.service_host } : { securityJsCode: c.code };
    const sc = document.createElement("script");
    sc.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(c.key)}&plugin=AMap.Scale,AMap.ToolBar`;
    sc.onload = () => (window.AMap ? ok(window.AMap) : fail(new Error("地图没加载上")));
    sc.onerror = () => fail(new Error("连不上高德地图"));
    document.head.appendChild(sc);
  })).catch((e) => { LM.loading = null; throw e; });
  return LM.loading;
}
/** WGS-84 → GCJ-02（同电脑和手机的换算） */
function gcjJs(lat, lon) {
  if (lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lat, lon];
  const a = 6378245.0, ee = 0.00669342162296594323, x = lon - 105, y = lat - 35, P = Math.PI;
  let dLat = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  dLat += (20 * Math.sin(6 * x * P) + 20 * Math.sin(2 * x * P)) * 2 / 3 + (20 * Math.sin(y * P) + 40 * Math.sin(y / 3 * P)) * 2 / 3 + (160 * Math.sin(y / 12 * P) + 320 * Math.sin(y * P / 30)) * 2 / 3;
  let dLon = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  dLon += (20 * Math.sin(6 * x * P) + 20 * Math.sin(2 * x * P)) * 2 / 3 + (20 * Math.sin(x * P) + 40 * Math.sin(x / 3 * P)) * 2 / 3 + (150 * Math.sin(x / 12 * P) + 300 * Math.sin(x / 30 * P)) * 2 / 3;
  const rad = lat / 180 * P, m = 1 - ee * Math.sin(rad) ** 2, sq = Math.sqrt(m);
  return [lat + dLat * 180 / ((a * (1 - ee)) / (m * sq) * P), lon + dLon * 180 / (a / sq * Math.cos(rad) * P)];
}
/** 地图点上的小卡片：名字、起止 · 时长、去了哪家（认定的）或最可能的一家和把握 */
function pinCard(v, i) {
  const dur = spanText((visitEnd(v) - Date.parse(v.start)) / 1000);
  const g = (v.guesses || [])[0];
  let shop = "";
  if (v.confirmed === "picked" && (v.shops || []).length) shop = `去了 ${v.shops.map(shopShort).join("、")}`;
  else if (v.confirmed === "auto" || v.confirmed === "remembered") shop = g ? `${v.confirmed === "auto" ? "自动认出" : "按上次认定"} ${shopShort(g.name)} ${pctText(g.p)}` : "";
  else if (!v.label && !v.confirmed && g) shop = `可能是 ${shopShort(g.name)} ${pctText(g.p)}`;
  return `<div class="lm-card"><div class="lm-card-n"><span class="ptl-dot">${MARKS[Math.min(i, MARKS.length - 1)]}</span>${esc(placeName(v))}${badgeHtml(v)}</div>
    <div class="lm-card-m">${esc(visitSpan(v))} · ${esc(dur)}</div>${shop ? `<div class="lm-card-s">${esc(shop)}</div>` : ""}</div>`;
}
const pinHtml = (v, i, on) => `<div class="lm-pin${badgeOf(v) ? " often" : ""}${on ? " sel" : ""}${v.end ? "" : " now"}" >${MARKS[Math.min(i, MARKS.length - 1)]}</div>`;
/** 地图跟窗口一样高（减去上面的标题和页签） */
function fitLive(box) {
  const h = Math.max(420, window.innerHeight - box.getBoundingClientRect().top - 48);
  box.style.height = `${h}px`;
}
window.addEventListener("resize", () => { const b = document.getElementById("pl-live"); if (b) fitLive(b); });
async function drawLiveMap(visits, date, sel) {
  const box = document.getElementById("pl-live"); if (!box) return;
  fitLive(box);
  let A;
  try { A = await loadAmapJs(); }
  catch (e) { box.outerHTML = `<div class="pl-map-img" id="pl-map"><p class="note">${esc(String(e.message || e))}，先用静态图。</p></div>`; return drawPlaceMap(visits, sel); }
  if (!document.body.contains(box)) return;
  const keep = LM.day === date && LM.view;
  if (LM.map) { try { LM.map.destroy(); } catch (e) {} }
  box.innerHTML = "";
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const map = new A.Map(box, { zoom: 14, mapStyle: dark ? "amap://styles/dark" : "amap://styles/whitesmoke" });
  map.addControl(new A.Scale());
  map.addControl(new A.ToolBar({ position: { top: "12px", right: "12px" } }));
  const pts = visits.map((v) => { const [la, lo] = gcjJs(v.lat, v.lon); return [lo, la]; });
  if (pts.length > 1) map.add(new A.Polyline({ path: pts, strokeColor: "#73726C", strokeWeight: 2, strokeOpacity: 0.8, strokeStyle: "dashed", strokeDasharray: [6, 6] }));
  LM.visits = visits;
  // 小卡片：悬停时出、移开就收；点过的那个一直开着（再点或点别的才换）
  const card = new A.InfoWindow({ isCustom: true, anchor: "bottom-center", offset: new A.Pixel(0, -22), autoMove: false });
  LM.pinned = null;
  const showCard = (i) => { card.setContent(pinCard(visits[i], i)); card.open(map, pts[i]); };
  LM.card = card;
  LM.markers = visits.map((v, i) => {
    const m = new A.Marker({ position: pts[i], content: pinHtml(v, i, i === sel), offset: new A.Pixel(-13, -13), zIndex: i === sel ? 200 : 100 + i });
    m.on("mouseover", () => showCard(i));
    m.on("mouseout", () => { if (LM.pinned == null) card.close(); else if (LM.pinned !== i) showCard(LM.pinned); });
    m.on("click", () => {
      LM.pinned = LM.pinned === i ? null : i;
      if (LM.pinned == null) card.close(); else showCard(i);
      const same = PL_SEL.i === i; PL_SEL = same ? { date: null, i: null } : { date, i };
      $app.querySelectorAll("[data-sel]").forEach((x) => x.classList.toggle("is-sel", !same && +x.dataset.sel === i));
      liveSelect(same ? null : i, false);
      const row = $app.querySelector(`.pm-row[data-sel="${i}"]`); if (row && !same) row.scrollIntoView({ block: "nearest" });
    });
    return m;
  });
  map.add(LM.markers);
  if (keep) map.setZoomAndCenter(LM.view.zoom, LM.view.center, true);
  else map.setFitView(LM.markers, true, [80, 80, 80, 80]);
  const save = () => { LM.view = { zoom: map.getZoom(), center: map.getCenter() }; };
  map.on("moveend", save); map.on("zoomend", save);
  map.on("click", () => { LM.pinned = null; card.close(); });
  if (sel != null && pts[sel]) { LM.pinned = sel; showCard(sel); }
  LM.map = map; LM.day = date;
}
/** 选中一段：那个点变强调色压在最上面；从清单点的把地图挪过去（不缩小） */
function liveSelect(i, pan) {
  LM.markers.forEach((m, j) => { m.setContent(pinHtml(LM.visits[j], j, j === i)); m.setzIndex(j === i ? 200 : 100 + j); });
  if (pan && i != null && LM.map) LM.map.setZoomAndCenter(Math.max(LM.map.getZoom(), 15), LM.markers[i].getPosition());
  if (pan && LM.card && LM.map) { LM.pinned = i; if (i == null) LM.card.close(); else { LM.card.setContent(pinCard(LM.visits[i], i)); LM.card.open(LM.map, LM.markers[i].getPosition()); } }
}

/** 地图图片缓存：停留点和选中的那段没变就不再问高德（今天页每分钟自动刷新） */
const MAPCACHE = new Map();
/** 今天页选中的那段停留（哪天、第几段） */
let PL_SEL = { date: null, i: null };
function drawPlaceMap(visits, sel) {
  const pts = visits.map((v) => [v.lat, v.lon]), key = JSON.stringify([pts, sel, visits.map((v) => !!badgeOf(v))]);
  const show = (html) => { const box = document.getElementById("pl-map"); if (box) box.innerHTML = html; };
  if (MAPCACHE.has(key)) return show(MAPCACHE.get(key));
  call("amap_map", { points: pts, width: 640, height: 600, selected: sel, often: visits.map((v) => !!badgeOf(v)) })
    .then((src) => { const html = `<img src="${src}" alt="这天的停留点地图">`; MAPCACHE.set(key, html); if (MAPCACHE.size > 40) MAPCACHE.delete(MAPCACHE.keys().next().value); show(html); })
    .catch((x) => show(`<p class="note">${esc(String(x))}${String(x).includes("Key") ? "（设置 → 地图）" : ""}</p>`));
}
const TL = {
  tab: (() => { try { return localStorage.getItem("tl-tab") || "all"; } catch (e) { return "all"; } })(),
  view: (() => { try { return localStorage.getItem("today-view") || "overview"; } catch (e) { return "overview"; } })(),
  pview: (() => { try { return localStorage.getItem("place-view") || "stays"; } catch (e) { return "stays"; } })(),
  jump: null,
};
const localHour = (iso) => +hm(iso).slice(0, 2);
/** 系统界面这类不是「在用的 app」，不画图标 */
const NOT_APPS = new Set(["com.apple.dock", "com.apple.loginwindow", "com.apple.notificationcenterui", "com.apple.controlcenter", "com.apple.Spotlight", "com.apple.systemuiserver", "com.apple.WindowManager", "org.p0deje.Maccy"]);

/** 这天有摘要的电脑、设备页里改过的名字：时间线每行标上是哪台 */
let DAY_COMPUTERS = [], DAY_NAMES = {};
/** 设备 → 标签：改过名用改的名；没改过 mac-… 叫 Mac、win-… 叫 Windows，同一种有两台时带上机器名 */
function devLabel(dev) {
  if (DAY_NAMES[dev]) return DAY_NAMES[dev];
  const kind = (x) => (x.startsWith("win-") ? "Windows" : x.startsWith("mac-") ? "Mac" : x);
  const k = kind(dev || "");
  return DAY_COMPUTERS.filter((x) => kind(x) === k).length > 1 ? `${k} · ${dev.replace(/^(mac|win)-/, "")}` : k;
}

/** 手机页签：按停留点分组，新的在上。每组一行标题（地点、起止、待了多久），这段时间里拿手机的记录排在它下面；
 *  两个停留点之间的空档也成一组（路上／没记到位置），没有拿手机就不列 */
function phoneByPlace(items, visits, date) {
  const ses = items.filter((x) => !x.visit);
  const blocks = placeBlocks(visits, date).map((b) => ({ ...b, items: [] }));
  for (const x of ses) {
    const t = Date.parse(x.start);
    const b = blocks.find((y) => t >= y.a && t < y.z) || (t < blocks[0].a ? blocks[0] : blocks[blocks.length - 1]);
    b.items.push(x);
  }
  return blocks.reverse().filter((b) => b.kind === "stay" || b.items.length).map((b) => {
    const h = `data-h="${new Date(b.a).getHours()}"`;
    const head = b.kind === "stay"
      ? `<div class="tl-place" ${h}><span class="t">${visitSpan(b.v)}</span><span class="n"><i></i>${esc(placeName(b.v))}</span><span class="d">${spanText((b.z - b.a) / 1000)}${b.items.some((x) => x.ses) ? ` · 手机 ${minText(b.items.reduce((n, x) => n + (x.ses ? x.ses.sec : 0), 0))}` : ""}</span></div>`
      : `<div class="tl-place gap" ${h}><span class="t">${hmMs(b.a)}–${hmMs(b.z)}</span><span class="n">${b.kind === "go" ? "路上" : "没记到位置"}</span><span class="d">${spanText((b.z - b.a) / 1000)}</span></div>`;
    return head + b.items.sort((x, y) => (x.start < y.start ? 1 : -1)).map(tlRow).join("");
  }).join("");
}

function timelineItems(d) {
  DAY_COMPUTERS = d.computers || [];
  DAY_NAMES = d.device_names || {};
  const out = [];
  for (const s of d.segments || []) out.push({ dev: "computer", start: s.start, end: s.end, seg: s });
  for (const x of (d.phone && d.phone.sessions) || []) out.push({ dev: "phone", start: x.start, end: x.end, ses: x });
  for (const v of (d.places && d.places.visits) || []) out.push({ dev: "phone", start: v.start, end: v.end, visit: v });
  SELF = (d.speech && d.speech.self) || null;
  // 对话按录它的设备归页签：手表录的在「手表」，iPhone 自己录的在「手机」
  for (const c of (d.speech && d.speech.conversations) || []) out.push({ dev: (c.device || "").startsWith("iphone-") ? "phone" : "watch", start: c.start, end: c.end, conv: c });
  return out.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0));
}

const minText = (sec) => (sec < 60 ? `${sec} 秒` : `${Math.round(sec / 60)} 分钟`);

function icons(ids, phone, names = {}) {
  const list = ids.filter((b) => b && !NOT_APPS.has(b)).slice(0, 10);
  if (!list.length) return "";
  return `<div class="apps">${list.map((b) => {
    const name = names[b] || b.split(".").pop();
    return `<span class="ico" data-b="${esc(b)}" data-p="${phone ? 1 : 0}" title="${esc(name)}">${esc((name[0] || "?").toUpperCase())}</span>`;
  }).join("")}</div>`;
}

/** 本人在转写里的名字（录音服务器按声纹认出的那个） */
let SELF = null;

/** 一段对话：标题行写时长和谁在说，第一句做预览，点开看原文 */
function convRow(c, h, t) {
  const who = speakers(c.talk || [], SELF);
  const sec = (c.talk || []).reduce((a, x) => a + x.sec, 0);
  const first = (c.lines || []).find((l) => l.text.length >= 4) || (c.lines || [])[0];
  const lines = (c.lines || []).map((l) => `<li><span class="ut">${hm(l.start)}${new Date(l.start).getSeconds() ? ":" + pad2(new Date(l.start).getSeconds()) : ":00"}</span><span class="who${l.speaker === SELF ? " self" : ""}">${esc(l.speaker)}</span><span>${esc(l.text)}</span></li>`).join("");
  return `<details class="tl-row watch" ${h}><summary>${t}<span><span class="name">对话 · ${talkText(sec)}</span><div class="desc">${esc(who.slice(0, 4).join("、"))}${who.length > 4 ? ` 等 ${who.length} 人` : ""}</div>${first ? `<div class="talk-line">${esc(first.speaker)}：${esc(first.text.length > 60 ? first.text.slice(0, 60) + "…" : first.text)}</div>` : ""}</span><span class="chev">${ICON.chevR}</span></summary>
    <div class="more"><ul class="utts">${lines}</ul><p class="note" style="margin:0">手表录音转写，可能有错字。「${esc(SELF || "本人")}」按声纹认出，「他人N」只在当天内是同一个人，「未辨」是太短认不出。</p></div></details>`;
}

function tlRow(x) {
  const t = `<span class="t">${hm(x.start)}–${x.end ? hm(x.end) : "现在"}</span>`;
  const h = `data-h="${localHour(x.start)}"`;
  if (x.conv) return convRow(x.conv, h, t);
  if (x.visit) return `<div class="tl-row phone place" ${h}>${t}<span><span class="name">在 ${esc(x.visit.name || "没有地名的地方")}</span></span></div>`;
  if (x.dev === "phone") {
    const s = x.ses;
    const names = Object.fromEntries(s.apps.map((a) => [a.bundle_id, a.name]));
    if (s.kind === "brief") return `<div class="tl-row phone brief" ${h}>${t}<span><span class="name">手机 · 拿起 ${s.count} 次，共 ${minText(s.sec)}</span>${icons(s.apps.map((a) => a.bundle_id), true, names)}</span></div>`;
    const top = s.apps.filter((a) => a.sec >= 5).slice(0, 4).map((a) => `${esc(a.name)} ${minText(a.sec)}`).join("、");
    return `<div class="tl-row phone" ${h}>${t}<span><span class="name">手机 · ${minText(s.sec)}</span>${top ? `<div class="desc">${top}</div>` : ""}${icons(s.apps.map((a) => a.bundle_id), true, names)}</span></div>`;
  }
  const s = x.seg;
  // 连续的「不在电脑前」已由 Rust 合成一段：一行灰字，不能展开
  if (s.kind === "idle") return `<div class="tl-row computer idle" ${h}>${t}<span>${esc(s.title)}</span></div>`;
  const ctx = (s.context || []).filter((y) => !y.includes("/Users/"));
  const more = [
    ctx.length ? `<div><h4>涉及</h4>${md(ctx.map((y) => "- " + y).join("\n"))}</div>` : "",
    s.recording ? `<div><h4>经过</h4>${md(s.recording)}</div>` : s.memory ? `<div><h4>经过</h4>${md(s.memory)}</div>` : "",
  ].join("");
  const tag = (s.kind === "6h" ? `<span class="mx-tag">6 小时</span>` : s.source === "codex" ? `<span class="mx-tag">Codex</span>` : "")
    + (s.device ? `<span class="mx-tag">${esc(devLabel(s.device))}</span>` : "");
  return `<details class="tl-row computer" ${h}><summary>${t}<span><span class="name">${esc(s.title || "（没有标题）")}${tag}</span>${s.description ? `<div class="desc">${esc(s.description)}</div>` : ""}${icons(s.apps || [], false)}</span>${more ? `<span class="chev">${ICON.chevR}</span>` : "<span></span>"}</summary>${more ? `<div class="more">${more}</div>` : ""}</details>`;
}

/** 先画首字母，图标取到后换上（手机 app 第一次要联网查，之后走缓存） */
const ICONS = { 0: {}, 1: {} };
async function loadIcons() {
  for (const p of [0, 1]) {
    const els = [...$app.querySelectorAll(`.ico[data-p="${p}"]`)];
    const need = [...new Set(els.map((e) => e.dataset.b))].filter((b) => !(b in ICONS[p]));
    if (need.length && TAURI) Object.assign(ICONS[p], await call("get_icons", { ids: need, phone: !!p }).catch(() => ({})));
    for (const e of $app.querySelectorAll(`.ico[data-p="${p}"]`)) {
      const got = ICONS[p][e.dataset.b];
      // 名字表里没有的 app，用 App Store 上的名字
      if (got && got.name && e.title === e.dataset.b.split(".").pop()) e.title = got.name;
      if (got && got.icon && !e.querySelector("img")) { e.textContent = ""; e.classList.add("has-img"); const img = new Image(); img.src = got.icon; img.alt = ""; e.appendChild(img); }
    }
  }
}

// ---------- 日总结 ----------

const SUM = { err: null };

/** 日／周／月 页签（月后续做；周总结电脑上写，手机上还没有） */
const summaryTabs = (on, date) => `<div class="tabs" role="tablist">
  <button role="tab" aria-selected="${on === "day"}" class="${on === "day" ? "is-on" : ""}" data-tab="day">日</button>
  <button role="tab" aria-selected="${on === "week"}" class="${on === "week" ? "is-on" : ""}" data-tab="week" ${S.status && S.status.mobile ? "disabled" : ""}>周</button>
  <button role="tab" aria-selected="false" disabled title="后续做">月</button></div>`;
function bindTabs(date) {
  for (const b of document.querySelectorAll("[data-tab]")) b.onclick = () => { location.hash = b.dataset.tab === "week" ? `#/summary/week/${date}` : `#/summary/${date}`; };
}

async function renderSummary(arg, arg2) {
  if (arg === "week") return renderWeek(arg2);
  const dates = S.days.map((x) => x.date);
  const date = dates.includes(arg) ? arg : dates[0];
  if (!date) { $app.innerHTML = header("总结") + emptyInline("还没有日数据。"); return; }
  markNav("summary");
  const i = dates.indexOf(date);
  const prev = dates[i + 1], next = dates[i - 1];
  const d = await call("get_day", { date });
  const idx = S.days[i];
  const pack = (d && d.pack) || {}, ph = (d && d.phone) || null;
  // 还没有数据包（通常是今天）：电脑读数用自采事件实时算的
  const c = pack.computer && pack.computer.active_sec != null && !pack.partial ? pack.computer : (d && d.live) || pack.computer || {};
  const pp = pack.phone || {};
  // 熬夜＝这一晚：当天 21:00 以后＋次日 0–5 点（规格/日总结.md：凌晨 0–5 点属于前一晚），电脑和手机分别算再相加
  const nd = addDays(date, 1);
  const n = dates.includes(nd) ? await call("get_day", { date: nd }) : null;
  const npack = (n && n.pack) || {};
  const lateC = c.late_sec ?? secsAfter((d && d.live && d.live.spans) || [], date, 21);
  const lateP = ph ? ph.late_sec || 0 : pp.late_sec || 0;
  const dawnP = n ? (n.phone ? n.phone.night_sec || 0 : (npack.phone || {}).dawn_sec || 0) : 0;
  const dawnC = n ? hourSecs((n.live && n.live.active_hours) ? n.live : npack.computer).slice(0, 5).reduce((a, b) => a + b, 0) : 0;
  const night = Math.round((lateC + lateP + dawnP + dawnC) / 60);
  const hasNight = c.late_sec != null || (d && d.live) || ph || pp.late_sec != null;
  const sum = d && d.summary_md ? splitSummary(d.summary_md) : null;
  // 没写成的原因（模型出错、这一天没记录）：自动重试前先让人看到
  const failed = sum || !TAURI ? null : await call("daily_status", { date }).catch(() => null);
  const isToday = date === localDay();

  const right = `<button class="mx-iconbtn" id="prev" aria-label="前一天" title="前一天" ${prev ? "" : "disabled"}>${ICON.chevL}</button>
    <button class="mx-iconbtn" id="next" aria-label="后一天" title="后一天" ${next ? "" : "disabled"}>${ICON.chevR}</button>
    <div class="pick"><button class="mx-btn mx-btn--secondary mx-num" id="pick" aria-haspopup="menu" aria-expanded="false">${short(date)}${ICON.chevD}</button>
      <div class="mx-menu" role="menu" id="pick-menu" hidden>${dates.map((x) => `<button role="menuitemradio" aria-checked="${x === date}" data-date="${x}">${short(x)}${x === date ? `<span class="mx-check">${ICON.check}</span>` : ""}</button>`).join("")}</div></div>`;

  // 最近 14 天：截至这一天
  const byDate = Object.fromEntries(S.days.map((x) => [x.date, x]));
  const rows = Array.from({ length: 14 }, (_, k) => {
    const ymd = addDays(date, k - 13), x = byDate[ymd];
    return { date: ymd, has: !!x, hc: hourMinutes(x && x.hc), hp: hourMinutes(x && x.hp) };
  });
  const after = byDate[nd];
  if (after) rows[rows.length - 1].next = { hc: hourMinutes(after.hc), hp: hourMinutes(after.hp) };

  // 布局照 Claude「自定义」页：标题单独一行；下面一行左边 日／周／月 页签（月后续做），右边翻日期
  const kinds = summaryTabs("day", date);
  $app.innerHTML = header("总结") + `<div class="toolbar">${kinds}<div class="toolbar-right">${right}</div></div>` + `<div class="reading">
    <div class="readouts">
      ${readout("在电脑前", hh(c.active_sec ?? idx.active_sec), "h", c.first ? `${c.first}–${c.last}` : "取不到")}
      ${readout("手机", hh(ph ? ph.total_sec : pp.total_sec ?? idx.phone_sec), "h", ph ? `同步至 ${ymdhm(ph.synced_until)}` : pp.synced_at ? `同步至 ${pp.synced_at}` : "取不到")}
      ${readout("拿起", ph ? ph.pickups : pp.pickups ?? "—", "次", "", false, "按前台空档推算")}
      ${readout("熬夜", hasNight ? night : "—", "分钟", "21:00–5:00", night > 10)}
    </div>
    ${sum && sum.note ? `<p class="note" style="margin:var(--space-3) 0 0">${esc(sum.note)}</p>` : ""}
    <div style="margin-top:var(--space-6)">
      ${sum ? sum.parts.map((p) => section(p.title, p.title === "今天的一句话" ? `<p class="quote">${esc(p.body)}</p>` : md(p.body))).join("")
            : section("这一天", `<div class="gen-empty"><p class="mx-empty-inline">${isToday ? "还没有日总结，21:30 自动生成" : failed ? "日总结没写成，稍后自动重试" : "还没有日总结，稍后自动补上"}</p>
                <button class="mx-btn mx-btn--primary mx-btn--sm" id="gen-daily">现在生成</button>${SUM.err || (failed && failed.error) ? `<div class="mx-field-error">${esc(SUM.err || failed.error)}</div>` : ""}</div>`)}
      ${section("最近 14 天", actogram(rows, date))}
    </div></div>`;

  const gen = document.getElementById("gen-daily");
  if (gen) gen.onclick = async () => {
    gen.disabled = true; gen.textContent = "生成中…"; SUM.err = null;
    try { await call("generate_daily", { date }); } catch (x) { SUM.err = String(x); }
    renderSummary(date);
  };
  bindTabs(date);
  const go = (x) => { if (x) location.hash = `#/summary/${x}`; };
  document.getElementById("prev").onclick = () => go(prev);
  document.getElementById("next").onclick = () => go(next);
  const pick = document.getElementById("pick"), menu = document.getElementById("pick-menu");
  pick.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; pick.setAttribute("aria-expanded", String(!menu.hidden)); };
  menu.onclick = (e) => { const b = e.target.closest("button"); if (b) go(b.dataset.date); };
}

async function renderWeek(arg) {
  markNav("summary");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(arg || "") ? arg : (S.days[0] && S.days[0].date) || localDay();
  const w = await call("get_week", { date });
  const prev = addDays(w.monday, -7), next = addDays(w.monday, 7);
  const done = w.sunday < localDay();
  const sum = w.summary_md ? splitSummary(w.summary_md) : null;
  const right = `<button class="mx-iconbtn" id="prev" aria-label="前一周" title="前一周">${ICON.chevL}</button>
    <button class="mx-iconbtn" id="next" aria-label="后一周" title="后一周" ${next > localDay() ? "disabled" : ""}>${ICON.chevR}</button>
    <span class="mono week-range">${w.monday.slice(5)} – ${w.sunday.slice(5)}</span>`;
  const days = `<div class="week-days">${w.days.map((x) => `<a href="#/summary/${x.date}"><span class="mono">${short(x.date)}</span><span class="${x.line ? "" : "muted"}">${esc(x.line || "没有日总结")}</span></a>`).join("")}</div>`;
  const err = SUM.err || w.error;
  $app.innerHTML = header("总结") + `<div class="toolbar">${summaryTabs("week", date)}<div class="toolbar-right">${right}</div></div><div class="reading">
    ${sum && sum.note ? `<p class="note" style="margin:var(--space-3) 0 0">${esc(sum.note)}</p>` : ""}
    <div style="margin-top:var(--space-6)">
      ${sum ? sum.parts.map((p) => section(p.title, p.title === "这周的一句话" ? `<p class="quote">${esc(p.body)}</p>` : md(p.body))).join("")
            : section("这一周", `<div class="gen-empty"><p class="mx-empty-inline">${done ? "还没有周总结，稍后自动补上" : "这周还没过完，过完自动生成"}</p>
                <button class="mx-btn mx-btn--primary mx-btn--sm" id="gen-weekly">现在生成</button>${err ? `<div class="mx-field-error">${esc(err)}</div>` : ""}</div>`)}
      ${section("每天", days)}
    </div></div>`;
  SUM.err = null;
  bindTabs(date);
  const gen = document.getElementById("gen-weekly");
  if (gen) gen.onclick = async () => {
    gen.disabled = true; gen.textContent = "生成中…";
    try { await call("generate_weekly", { date }); } catch (x) { SUM.err = String(x); }
    renderWeek(date);
  };
  document.getElementById("prev").onclick = () => { location.hash = `#/summary/week/${prev}`; };
  document.getElementById("next").onclick = () => { if (next <= localDay()) location.hash = `#/summary/week/${next}`; };
}

// ---------- 规矩 ----------

const RS = { deleting: null };

/** 把一条规矩识别成能算的三类；识别不了返回 null（交给日总结对照）
 *  after：几点以后不用（电脑／手机／都不用）；limit：某设备每天不超过多久；app：某个 app 每天不超过多久 */
function parseRule(text) {
  const t = String(text).replace(/\s+/g, "");
  const dev = /电脑|mac/i.test(t) ? "computer" : /手机|iphone/i.test(t) ? "phone" : "any";
  let m = t.match(/(\d{1,2})(?:[:：点](\d{2})?)?(?:分)?(?:以后|之后|后)/);
  if (m && /不|别|停|关|禁/.test(t)) return { kind: "after", dev, h: +m[1] + (+m[1] < 12 && /晚上|夜里|夜间|下午|傍晚/.test(t) ? 12 : 0), m: +(m[2] || 0) };
  m = t.match(/(不超过|少于|最多|以内|不到|≤|<=?)(\d+(?:\.\d+)?)(小时|h|分钟|min|分)/i) || t.match(/(\d+(?:\.\d+)?)(小时|h|分钟|min|分)(以内|以下)/i);
  if (m) {
    const [num, unit] = /\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[3]];
    const minutes = +num * (/小时|h/i.test(unit) ? 60 : 1);
    const subject = t.split(/每天|一天|每日|不超过|少于|最多|不到/)[0].replace(/^(用|玩|刷|看)/, "");
    if (dev !== "any" && /^(用|玩|刷|看)?(电脑|手机|mac|iphone)?$/i.test(subject)) return { kind: "limit", dev, minutes };
    if (subject) return { kind: "app", app: subject.replace(/^(用|玩|刷|看)/, ""), minutes };
  }
  return null;
}

/** 用今天的实时数据对照一条规矩：{label: 对照什么, value: 今天多少, ok: 是否守住（null＝还没到点）} */
function checkRule(r, d) {
  if (!d) return null;
  const live = d.live || {}, ph = d.phone || {};
  const dayStart = toDate(d.date).getTime();
  const overlap = (a, b, from) => Math.max(0, Math.min(b, dayStart + 864e5) - Math.max(a, from)) / 1000;
  if (r.kind === "after") {
    const from = dayStart + (r.h * 60 + r.m) * 6e4;
    const when = `${pad2(r.h)}:${pad2(r.m)}`;
    const what = r.dev === "phone" ? "用手机" : r.dev === "computer" ? "用电脑" : "用电脑和手机";
    if (Date.now() < from) return { label: `还没到 ${when}`, value: "", ok: null };
    let sec = 0;
    if (r.dev !== "phone") for (const [a, b] of live.spans || []) sec += overlap(Date.parse(a), Date.parse(b), from);
    if (r.dev !== "computer") for (const x of ph.sessions || []) { const a = Date.parse(x.start), b = Date.parse(x.end); sec += b > a ? (overlap(a, b, from) / ((b - a) / 1000)) * x.sec : 0; }
    return { label: `${when} 以后${what}`, value: `${Math.round(sec / 60)} 分钟`, ok: sec < 60 };
  }
  if (r.kind === "limit") {
    const sec = r.dev === "phone" ? ph.total_sec || 0 : live.active_sec || 0;
    return { label: `今天${r.dev === "phone" ? "手机" : "电脑"}`, value: `${hh(sec)} / ${+(r.minutes / 60).toFixed(1)} 小时`, ok: sec <= r.minutes * 60 };
  }
  if (r.kind === "app") {
    const key = r.app.toLowerCase();
    const hit = (x) => (x.name || "").toLowerCase().includes(key) || (x.bundle_id || "").toLowerCase().includes(key);
    let sec = 0;
    for (const x of ph.sessions || []) for (const a of x.apps) if (hit(a)) sec += a.sec;
    for (const a of live.apps || []) if (hit(a)) sec += a.sec;
    return { label: `今天${r.app}（电脑和手机）`, value: `${Math.round(sec / 60)} / ${r.minutes} 分钟`, ok: sec <= r.minutes * 60 };
  }
  return null;
}

/** 加一条或改一条规矩（小弹层） */
function ruleDialog(r, save) {
  openDialog({
    title: r ? "改规矩" : "加一条规矩", ok: r ? "保存改动" : "加上这条",
    body: `<div class="mx-field"><label for="rule-text">规矩</label><textarea class="mx-input dlg-ta" id="rule-text" placeholder="用自己的话写，比如「21:00 以后不开电脑」">${esc(r ? r.text : "")}</textarea>
      <p class="note">「几点以后不用电脑／手机」「电脑／手机每天不超过几小时」「某个 app 每天不超过几分钟」会当场对照，别的写法交给日总结。⌘↩ 保存。</p></div>`,
    submit: async (el) => {
      const text = dlgVal(el, "rule-text");
      if (!text) throw "先写一条规矩。";
      if (r) S.rules.find((x) => x.id === r.id).text = text;
      else S.rules.unshift({ id: "r" + Date.now().toString(36), text, enabled: true });
      await save();
    },
  });
}

async function renderRules() {
  if (!S.rules) S.rules = await call("get_rules");
  const rules = S.rules;
  const today = await call("get_day", { date: localDay() }).catch(() => null);
  const verdict = (r) => {
    if (r.enabled === false) return `<div class="verdict muted">暂不对照</div>`;
    const c = checkRule(parseRule(r.text) || {}, today);
    if (!c) return `<div class="verdict muted">这条算不出来，交给日总结对照</div>`;
    return `<div class="verdict ${c.ok === null ? "muted" : c.ok ? "ok" : "over"}"><span>${esc(c.label)}</span>${c.value ? `<b>${esc(c.value)}</b>` : ""}${c.ok === null ? "" : c.ok ? ` · 守住了` : ` · 没守住`}</div>`;
  };
  const row = (r, i) => `<div class="rule${r.enabled === false ? " off" : ""}" data-id="${r.id}">
      <div class="mx-row"><span class="mx-row-mark mono">${i + 1}</span>
        <div class="mx-row-main"><div class="mx-row-name">${esc(r.text)}</div>${verdict(r)}</div>
        <div class="acts"><button class="mx-btn mx-btn--text mx-btn--sm" data-act="edit">改</button><button class="mx-btn mx-btn--text mx-btn--sm" data-act="delete">删除</button></div>
        <button class="mx-switch" role="switch" aria-checked="${r.enabled !== false}" aria-label="对照这条" title="${r.enabled !== false ? "日总结对照这条" : "暂不对照"}" data-act="toggle"></button>
      </div>
      ${RS.deleting === r.id ? `<div class="mx-confirm"><div class="mx-confirm-text"><b>删除这条规矩？</b><span>删了找不回来。</span></div><button class="mx-btn mx-btn--secondary" data-act="keep">取消</button><button class="mx-btn mx-btn--danger" data-act="remove">删除这条</button></div>` : ""}
    </div>`;
  $app.innerHTML = header("规矩", `<button class="mx-btn mx-btn--primary" id="add">加一条规矩</button>`)
    + `<div class="reading" id="rules">
      ${rules.length ? rules.map(row).join("") : emptyInline("用自己的话写一条规矩，比如「21:00 以后不开电脑」")}
    </div>`;
  const save = async () => { await call("save_rules", { rules: S.rules }); renderRules(); };
  document.getElementById("add").onclick = () => { RS.deleting = null; ruleDialog(null, save); };
  const keepBtn = $app.querySelector('[data-act="keep"]');
  if (keepBtn) keepBtn.focus();
  document.getElementById("rules").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const box = b.closest("[data-id]"), id = box.dataset.id, act = b.dataset.act;
    if (act === "edit") { RS.deleting = null; return ruleDialog(S.rules.find((r) => r.id === id), save); }
    if (act === "delete") { RS.deleting = id; return renderRules(); }
    if (act === "keep") { RS.deleting = null; return renderRules(); }
    if (act === "remove") { S.rules = S.rules.filter((r) => r.id !== id); RS.deleting = null; return save(); }
    if (act === "toggle") { const r = S.rules.find((x) => x.id === id); r.enabled = r.enabled === false; return save(); }
  };
  $app.onkeydown = (e) => { if (e.key === "Escape" && RS.deleting) { RS.deleting = null; renderRules(); } };
}

// ---------- 设备：绑定的电脑和手机，各自的记录状态 ----------

const DS = { open: null, msg: null, err: null, busy: false, account: null, removing: null };
const DEV_ICON = {
  mac: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  win: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  iphone: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/></svg>',
  watch: '<svg class="mx-ico lu" viewBox="0 0 24 24"><rect width="12" height="12" x="6" y="6" rx="3"/><path d="M9 6l.6-3.5h4.8L15 6M9 18l.6 3.5h4.8L15 18"/></svg>',
};
const bytesText = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : b >= 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");
const numText = (n) => Number(n || 0).toLocaleString("en-US");

/** 设备页：照墨线的列表页和设置页——「设备」一组（一台一行，点进去是设备详情页）、「同步」一组（设置行）。
 *  本机缺权限时顶上一条提示 */
async function renderDevices() {
  const [devs, st, sy] = await Promise.all([call("list_devices").catch(() => []), call("get_status"), call("sync_status").catch(() => ({}))]);
  // 登录着的设备：进页面取一次，失败（没网、令牌失效）就不显示
  if (sy.email && !sy.need_login && !DS.account) { DS.account = {}; call("account_info").then((a) => { DS.account = a; if (S.page === "devices" && !DEV.id) renderDevices(); }).catch(() => {}); }
  S.status = st; S.sync = sy; renderSide();
  // 登录着的设备列表也用改过的名字
  DS.names = Object.fromEntries(devs.filter((d) => d.custom).map((d) => [d.id, d.name]));
  DS.devs = devs;
  const perm = st.permissions || {};
  const me = devs.find((d) => d.this);
  const missing = [["accessibility", "辅助功能"], ["input_monitoring", "输入监控"], ["full_disk_access", "完全磁盘访问"]].filter(([k]) => perm[k] === false).map(([, n]) => n);
  const notice = me && missing.length ? `<div class="mx-notice"><span>这台电脑缺${missing.join("、")}权限，记不全。</span><a class="mx-btn mx-btn--secondary mx-btn--sm" href="#/devices/${encodeURIComponent(me.id)}">去处理</a></div>` : "";
  const adding = `<div class="add-dev">
      <div class="add-opt">${DEV_ICON.iphone}<div><b>iPhone</b><span>不用装 app。iPhone 上打开 设置 → 屏幕使用时间 →「跨设备共享」，用同一个 Apple 账号，这台 Mac 就能读到。</span></div></div>
      <div class="add-opt">${DEV_ICON.mac}<div><b>另一台 Mac</b><span>装上 Beayy，在设置里用同一个账号登录，记录就会同步过来，出现在下面的列表里。</span></div></div>
      <div class="add-opt">${DEV_ICON.win}<div><b>Windows 电脑</b><span>装上 Windows 版，用同一个账号登录。记的内容和 Mac 一样（打字、点击、界面文字、切换程序、在不在电脑前），还在试用。</span></div></div>
    </div>`;
  const rows = devs.map((d) => `<a class="mx-row" href="#/devices/${encodeURIComponent(d.id)}"><span class="mx-row-mark">${DEV_ICON[d.kind] || DEV_ICON.mac}</span>
      <span class="mx-row-main"><div class="mx-row-name">${esc(d.name)}${d.this ? `<span class="mx-tag">本机</span>` : ""}${d.synced ? `<span class="mx-tag">经同步</span>` : ""}</div><div class="mx-row-desc">${devStatus(d, st)}</div></span>
      <span class="mx-row-side">${ICON.chevR}</span></a>`).join("");
  $app.innerHTML = header("设备", `<button class="mx-btn mx-btn--primary" id="add-dev">添加设备</button>`)
    + `<div class="reading">${notice}${section("设备", rows ? `<div class="mx-list">${rows}</div>` : emptyInline("还没有设备"))}${syncSection(sy)}</div>`;
  document.getElementById("add-dev").onclick = () => openDialog({ title: "添加设备", body: adding, cancel: "关闭" });
  bindSync();
  if (sy.running || DS.busy) pollSync();
}

/** 设备一行下面那句状态 */
function devStatus(d, st) {
  const perm = (st && st.permissions) || {};
  if (d.this) {
    const missing = !perm.accessibility || !perm.input_monitoring;
    const [cls, text] = st.paused ? ["", st.paused_until ? `已暂停，${hm(st.paused_until)} 自动继续` : "已暂停"] : missing ? ["warn", "缺权限"] : st.capturing ? ["ok", "记录中"] : ["", "没在记录"];
    return `<span class="dot ${cls}"></span>${text} · 今天已记 ${numText(st.events_today)} 条`;
  }
  const m = String((st && st.phone_sync) || "").match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  if (d.kind === "iphone" && !d.synced) {
    // 超过一天没有新数据：变提醒样式
    const at = m ? m[0] : d.last, stale = !at || Date.now() - Date.parse(at) > 86400e3;
    return `<span class="dot ${stale ? "warn" : "ok"}"></span>同步至 ${ymdhm(at) || "—"} · ${howto("screentime", "怎么设置")}`;
  }
  if (d.synced) return `经同步 · 最近一条 ${ymdhm(d.last)}`;
  return `最近一条 ${ymdhm(d.last)}`;
}

/** 每种设备记什么：一行一项 */
const DEV_RECORDS = {
  mac: ["切换 app 和窗口", "键盘输入和发送（密码框打码）", "点击和滚动", "界面上的文字", "在不在电脑前、锁屏、睡眠", "10 分钟摘要"],
  win: ["切换程序和窗口", "键盘输入和发送（密码框打码）", "点击和滚动", "界面上的文字", "在不在电脑前、锁屏、睡眠", "10 分钟摘要"],
  iphone: ["每个 app 在前台的时长", "停留点：到了哪、待了多久"],
  watch: ["录音转成的文字，分出说话人", "录音时记下的停留点"],
};

/** 设备详情页：DetailHeader（返回、名字、状态、操作菜单）＋ 下划线页签 概况／事件 */
const DEV = { id: null, tab: "overview", events: [], more: false, type: "all", live: true, open: new Set(), timer: null, err: null };
async function renderDevice(id, tab) {
  if (DEV.id !== id) { DEV.events = []; DEV.more = false; DEV.type = "all"; DEV.open = new Set(); DEV.err = null; }
  DEV.id = id; DEV.tab = tab === "events" ? "events" : "overview";
  const [devs, st] = await Promise.all([DS.devs ? Promise.resolve(DS.devs) : call("list_devices").catch(() => []), call("get_status")]);
  S.status = st; renderSide();
  const d = devs.find((x) => x.id === id);
  if (!d) { location.hash = "#/devices"; return; }
  const base = `#/devices/${encodeURIComponent(id)}`;
  const head = `<div class="dev-detail"><a class="mx-back" href="#/devices">${ICON.chevL}设备</a>
    <div class="mx-detail"><span class="mx-detail-mark">${DEV_ICON[d.kind] || DEV_ICON.mac}</span><div class="mx-detail-main"><h1>${esc(d.name)}</h1><p>${devStatus(d, st)}${d.this ? " · 本机" : ""}</p></div>
      <div class="pick"><button class="mx-btn mx-btn--secondary" id="dev-ops" aria-haspopup="menu" aria-expanded="false">操作${ICON.chevD}</button>
        <div class="mx-menu" role="menu" hidden><button role="menuitem" id="dev-rename">重命名</button></div></div></div>
    <nav class="mx-utabs"><a href="${base}" class="${DEV.tab === "overview" ? "is-on" : ""}">概况</a><a href="${base}/events" class="${DEV.tab === "events" ? "is-on" : ""}">事件</a></nav></div>`;
  $app.innerHTML = `<div class="reading">${head}<div id="dev-body">${DEV.tab === "events" ? evShell(d) : devOverview(d, st)}</div></div>`;
  bindPick(document.getElementById("dev-ops"));
  document.getElementById("dev-rename").onclick = () => renameDialog(d, () => { DS.devs = null; renderDevice(id, DEV.tab); });
  $app.querySelectorAll("[data-perm]").forEach((b) => (b.onclick = () => call("open_permission", { kind: b.dataset.perm })));
  if (DEV.tab === "events") { DEV.drawn = false; bindEvents(d); await loadEvents(d, false); startEventsTimer(d); } else stopEventsTimer();
}

function devOverview(d, st) {
  const perm = st.permissions || {};
  const permRow = (kind, name, desc) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>
    <span class="mx-status mx-status--${perm[kind] ? "ok" : "warn"}">${perm[kind] ? "已授权" : "未授权"}</span>${perm[kind] ? "" : `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-perm="${kind}">去授权</button>`}</div>`;
  const stats = `<div class="mx-stats dev-stats">
      <div class="mx-stat"><div class="mx-stat-label">记录从</div><div class="mx-stat-value mx-num">${esc(mdhm(d.first) || "—")}</div></div>
      <div class="mx-stat"><div class="mx-stat-label">最近一条</div><div class="mx-stat-value mx-num">${esc(ymdhm(d.last) || "—")}</div></div>
      <div class="mx-stat"><div class="mx-stat-label">共</div><div class="mx-stat-value mx-num">${numText(d.events)}<small>条</small></div></div>
      <div class="mx-stat"><div class="mx-stat-label">占用</div><div class="mx-stat-value mx-num">${bytesText(d.bytes).replace(/ (\S+)$/, "<small>$1</small>")}</div></div></div>`;
  const kind = d.kind === "win" ? "win" : d.kind;
  const recs = DEV_RECORDS[kind] || DEV_RECORDS.mac;
  const what = section("记什么", `<ul class="dev-recs">${recs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`, { aside: `<a href="#/devices/${encodeURIComponent(d.id)}/events">看最近的事件</a>` });
  const perms = d.this && !IS_WIN ? section("权限", `<div class="rows">${permRow("accessibility", "辅助功能", "读取窗口标题和屏幕上的文字")}${permRow("input_monitoring", "输入监控", "判断你在打字还是程序在操作")}${permRow("full_disk_access", "完全磁盘访问", `读取 iPhone 的屏幕使用时间 · ${howto("screentime", "怎么设置")}`)}</div>`) : "";
  return stats + what + perms + `<p class="note dev-id">设备编号 <span class="mono">${esc(d.id)}</span></p>`;
}

// ---------- 设备详情 · 事件：最近的原始事件，新的在上；页面开着时每 3 秒刷新 ----------

/** 筛选：显示名 → 事件种类（以「.」结尾按前缀）；每种设备只列它会有的 */
const EV_TYPES = {
  all: ["全部", null],
  input: ["打字和发送", ["keyboard."]],
  mouse: ["点击和滚动", ["mouse."]],
  switch: ["切换", ["app.activated", "window.changed", "app.focus"]],
  ui: ["界面文字", ["ui.text"]],
  presence: ["在不在", ["presence", "heartbeat", "screen.", "system."]],
  speech: ["对话", ["speech."]],
  place: ["位置", ["place.visit"]],
  bg: ["后台", ["sync.run", "summary.run", "phone.sync", "relay.sync", "app.launch", "app.quit", "permission.", "tap.started"]],
};
const EV_KINDS = { mac: ["all", "input", "mouse", "switch", "ui", "presence", "bg"], win: ["all", "input", "mouse", "switch", "ui", "presence", "bg"], iphone: ["all", "switch", "place"], watch: ["all", "speech", "place"] };

/** 一条事件的种类标签 */
function evTag(t) {
  const m = { "keyboard.text_input": "打字", "keyboard.submit": "发送", "keyboard.return": "回车", "keyboard.shortcut": "快捷键", "mouse.click": "点击", "mouse.scroll": "滚动",
    "app.activated": "切换", "window.changed": "窗口", "app.focus": "前台", "ui.text": "界面文字", heartbeat: "心跳", presence: "在不在", "speech.utterance": "说话", "speech.segment": "录音",
    "place.visit": "停留", "sync.run": "同步", "summary.run": "摘要", "phone.sync": "读 iPhone", "relay.sync": "拉录音", "app.launch": "启动", "app.quit": "退出" };
  return m[t] || (/^(screen|system)\./.test(t) ? "屏幕" : /^permission\./.test(t) ? "权限" : t);
}

/** 打的字：去掉方向键、退格这些控制字符，回车写成 ⏎ */
const typedText = (s) => String(s || "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n/g, " ⏎ ").trim();
/** 这次打字敲了几下键（人敲的＋代理敲的） */
const keyCount = (e) => Object.values(e.keys || {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
const clip = (s, n = 80) => (s.length > n ? s.slice(0, n) + "…" : s);
const durText = (sec) => (sec < 60 ? `${Math.round(sec)} 秒` : sec < 3600 ? `${Math.round(sec / 60)} 分钟` : `${hh(sec)} 小时`);

/** 一条事件的一句人话（打的字、界面文字原样写出来：只在本机显示） */
function evText(e) {
  const app = e.app_name || "";
  const at = app ? `在 ${app} ` : "";
  const el = e.element || {};
  const who = e.actor && e.actor.kind === "agent" ? `代理（${e.actor.source_proc || "别的程序"}）` : e.actor_kind === "agent" ? "代理" : "";
  const elName = el.title || el.description || ({ AXButton: "按钮", AXTextField: "输入框", AXTextArea: "输入框", AXLink: "链接", AXMenuItem: "菜单项", AXCheckBox: "勾选框", AXTab: "页签", AXImage: "图片", AXStaticText: "文字" }[el.role] || "");
  switch (e.event_type) {
    case "keyboard.text_input": { const t = typedText(e.text || e.typed), n = keyCount(e); return t ? `${who}${at}打了「${clip(t)}」` : `${who}${at}敲了${n ? ` ${n} 下` : ""}键盘（没读到打的内容）`; }
    case "keyboard.submit": { const t = typedText(e.text), n = keyCount(e); return `${who}${at}发出${t ? `「${clip(t)}」` : ""}${n ? `（敲了 ${n} 下）` : ""}`; }
    case "keyboard.return": return `${who}${at}按了回车`;
    case "keyboard.shortcut": return `${who}${at}按了 ${e.keys || ""}`;
    case "mouse.click": return `${who}${at}点了${elName ? `「${clip(elName, 40)}」` : "一下"}${e.button === "right" ? "（右键）" : ""}`;
    case "mouse.scroll": return `${who}${at}滚了 ${e.ticks || 1} 格`;
    case "app.activated": return `切到 ${app}${e.window_title ? ` · ${clip(e.window_title, 50)}` : ""}`;
    case "window.changed": return `${app} 换了窗口${e.window_title ? `：${clip(e.window_title, 50)}` : ""}`;
    case "ui.text": return `读到 ${app} 的界面文字 ${e.lines || 0} 行${e.has_secure_field ? "（有密码框，已打码）" : ""}`;
    case "heartbeat": { const mobile = String(e.device || "").startsWith("android-") || String(e.device || "").startsWith("iphone-"); return e.idle_seconds > 180 ? `${mobile ? "手机" : "电脑"}空闲 ${durText(e.idle_seconds || 0)}` : `正在使用${mobile ? "手机" : app || "设备"}`; }
    case "presence": { const mobile = String(e.device || "").startsWith("android-") || String(e.device || "").startsWith("iphone-"); return e.state === "active" ? (mobile ? "开始使用手机" : "回到电脑前") : `离开${mobile ? "手机" : "电脑"}（空闲 ${durText(e.idle_seconds || 0)}）`; }
    case "screen.wake": return "屏幕亮了";
    case "screen.locked": return "锁屏";
    case "screen.unlocked": return "解锁";
    case "system.sleep": return "电脑睡眠";
    case "system.wake": return "电脑唤醒";
    case "app.focus": { const n = (ICONS[1][e.bundle_id] || {}).name || e.app_name || e.bundle_id || "未知应用"; return `${e.state === "start" ? "打开" : "离开"} ${n}`; }
    case "speech.utterance": return `${e.speaker || "未辨"}：${clip(String(e.text || ""), 120)}`;
    case "speech.segment": return `录了一段 ${durText(e.audio_sec || 0)}，有人说话 ${durText(e.speech_sec || 0)}${e.battery != null ? `，电量 ${Math.round(e.battery * 100)}%` : ""}`;
    case "place.visit": return `${e.depart ? "离开" : "到了"} ${e.label || e.name || "没有地名的地方"}`;
    case "sync.run": return `同步一轮：传 ${e.uploaded || 0} 段、收 ${e.downloaded || 0} 段${e.errors ? `，${e.errors} 个错` : ""}`;
    case "summary.run": return `写了 ${e.written || 0} 段摘要（${e.seconds || 0} 秒）`;
    case "phone.sync": return `从 iCloud 读到 iPhone 新记录 ${numText(e.added)} 条`;
    case "relay.sync": return `同步来 ${numText(e.added)} 条`;
    case "app.launch": return `Beayy ${e.version || ""} 启动${e.shadow ? "（测试版）" : ""}`;
    case "app.quit": return "Beayy 退出";
    case "tap.started": return "开始监听键盘和鼠标";
    case "permission.requested": return `申请${{ accessibility: "辅助功能", input_monitoring: "输入监控", full_disk_access: "完全磁盘访问" }[e.service] || e.service || ""}权限`;
    case "permission.changed": return "权限变了";
    default: return e.event_type || "（没有种类）";
  }
}

const hms = (iso) => { const t = new Date(iso); return `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`; };
const evKey = (e) => `${e.timestamp}|${e.event_type}|${e.bundle_id || ""}|${e.state || ""}|${e.text || e.app_name || ""}`;

function evShell(d) {
  const mobile = ["iphone", "android"].includes(d.kind) || String(d.id).startsWith("android-");
  const kinds = mobile ? EV_KINDS.iphone : EV_KINDS[d.kind] || EV_KINDS.mac;
  return `<div class="toolbar ev-bar"><div class="toolbar-left"><div class="pick"><button class="mx-btn mx-btn--secondary" id="ev-type" aria-haspopup="menu" aria-expanded="false">${EV_TYPES[DEV.type][0]}${ICON.chevD}</button>
      <div class="mx-menu" role="menu" hidden>${kinds.map((k) => `<button role="menuitemradio" aria-checked="${k === DEV.type}" data-ev-type="${k}">${EV_TYPES[k][0]}${k === DEV.type ? `<span class="mx-check">${ICON.check}</span>` : ""}</button>`).join("")}</div></div></div>
    <div class="toolbar-right"><span class="mx-status ${DEV.live ? "mx-status--ok" : ""}" id="ev-live-state">${DEV.live ? "实时 · 每 3 秒刷新" : "已暂停刷新"}</span><button class="mx-btn mx-btn--text mx-btn--sm" id="ev-live">${DEV.live ? "暂停" : "继续"}</button></div></div>
    <div id="ev-list"><p class="note">读取中…</p></div>
    <p class="note">打的字和界面文字只在这台电脑上显示，不进网站；密码框在记录时就打了码。</p>`;
}

function bindEvents(d) {
  bindPick(document.getElementById("ev-type"));
  $app.querySelectorAll("[data-ev-type]").forEach((b) => (b.onclick = () => { DEV.type = b.dataset.evType; DEV.events = []; DEV.open = new Set(); renderDevice(d.id, "events"); }));
  document.getElementById("ev-live").onclick = () => { DEV.live = !DEV.live; renderDevice(d.id, "events"); };
}

async function loadEvents(d, older) {
  const box = document.getElementById("ev-list");
  const scrollHost = document.querySelector(".body");
  const rows = box ? [...box.querySelectorAll(".ev-row")] : [];
  const top = scrollHost ? scrollHost.getBoundingClientRect().top : 0;
  const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top);
  const anchorKey = anchor && anchor.dataset.k;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top : 0;
  const beforeScroll = scrollHost ? scrollHost.scrollTop : 0;
  const types = EV_TYPES[DEV.type][1];
  const before = older && DEV.events.length ? DEV.events[DEV.events.length - 1].timestamp : null;
  let r;
  try { r = await call("recent_events", { device: d.id, before, limit: 200, types }); DEV.err = null; }
  catch (x) { DEV.err = String(x && x.message ? x.message : x); return drawEvents(d); }
  if (older) { DEV.events = DEV.events.concat(r.events); DEV.more = r.more; }
  else {
    const oldest = r.events.length ? r.events[r.events.length - 1].timestamp : null;
    const keep = oldest ? DEV.events.filter((e) => e.timestamp < oldest) : [];
    const same = DEV.events.length && r.events.length && DEV.events[0].timestamp === r.events[0].timestamp && DEV.events.length >= r.events.length;
    if (same && DEV.drawn) return;
    DEV.events = r.events.concat(keep);
    if (!keep.length) DEV.more = r.more;
  }
  drawEvents(d);
  if (!older && scrollHost && scrollHost.isConnected) {
    const next = anchorKey && [...document.querySelectorAll(".ev-row")].find((row) => row.dataset.k === anchorKey);
    scrollHost.scrollTop = next ? scrollHost.scrollTop + next.getBoundingClientRect().top - anchorOffset : beforeScroll;
  }
}

function drawEvents(d) {
  const box = document.getElementById("ev-list"); if (!box) return;
  DEV.drawn = true;
  if (DEV.err) { box.innerHTML = `<p class="mx-error">读不到事件：${esc(DEV.err)}</p>`; return; }
  if (!DEV.events.length) { box.innerHTML = emptyInline("最近 8 小时没有这类事件"); return; }
  const phone = ["iphone", "android"].includes(d.kind) || String(d.id).startsWith("android-");
  box.innerHTML = `<div class="ev-list">${DEV.events.map((e, i) => {
    const k = evKey(e, i), app = e.bundle_id && (e.app_name || phone) ? `<span class="ico" data-b="${esc(e.bundle_id)}" data-p="${phone ? 1 : 0}" title="${esc(e.app_name || e.bundle_id)}">${esc(((e.app_name || e.bundle_id.split(".").pop())[0] || "?").toUpperCase())}</span>` : `<span class="ico ico-none"></span>`;
    const raw = JSON.stringify(e, null, 2);
    const extra = e.event_type === "ui.text" && e.text ? `<pre class="ev-text">${esc(clip(String(e.text), 2000))}</pre>` : "";
    return `<details class="ev-row" data-k="${esc(k)}"${DEV.open.has(k) ? " open" : ""}><summary><span class="t mono">${hms(e.timestamp)}</span><span class="mx-tag">${esc(evTag(e.event_type))}</span>${app}<span class="ev-say">${esc(evText(e))}</span></summary><div class="ev-more">${extra}<pre class="ev-raw mono">${esc(raw)}</pre></div></details>`;
  }).join("")}</div>${DEV.more ? `<div class="btns ev-older"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ev-older">加载更早</button></div>` : ""}`;
  box.querySelectorAll(".ev-row").forEach((x) => x.addEventListener("toggle", () => { x.open ? DEV.open.add(x.dataset.k) : DEV.open.delete(x.dataset.k); }));
  const older = document.getElementById("ev-older"); if (older) older.onclick = () => loadEvents(d, true);
  loadIcons().then(() => { if (phone) box.querySelectorAll(".ev-row").forEach((x, i) => { const e = DEV.events[i]; if (e && e.event_type === "app.focus") x.querySelector(".ev-say").textContent = evText(e); }); });
}

function startEventsTimer(d) {
  stopEventsTimer();
  if (!DEV.live) return;
  DEV.timer = setInterval(() => {
    if (S.page !== "devices" || DEV.id !== d.id || DEV.tab !== "events" || !document.getElementById("ev-list")) return stopEventsTimer();
    loadEvents(d, false);
  }, 3000);
}
function stopEventsTimer() { if (DEV.timer) { clearInterval(DEV.timer); DEV.timer = null; } }

/** 下拉菜单（.pick 里的按钮＋.mx-menu）：点按钮开关，点外面或 Esc 关（见文末） */
function bindPick(btn) {
  if (!btn) return;
  const menu = btn.parentElement.querySelector(".mx-menu");
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
}

/** 给设备改名（小弹层）。改的名字会同步到别的设备，时间线上的标签也用它；清空＝改回默认名 */
function renameDialog(d, done) {
  if (!d) return;
  openDialog({
    title: "重命名设备", ok: "保存",
    body: dlgField("dev-name", "名称", { value: d.custom ? d.name : "", ph: d.default_name, help: "清空就改回默认名字" }),
    onOpen: (el) => { el.querySelector("#dev-name").maxLength = 40; },
    submit: async (el) => { await call("rename_device", { id: d.id, name: dlgVal(el, "dev-name") }); DS.devs = null; done ? done() : renderDevices(); },
  });
}

/** 同步进行中：每 2 秒只刷新同步卡片（进度条），同步完了整页重画一次（设备列表、最近一条会变） */
let SYNC_POLL = null;
function pollSync() {
  if (SYNC_POLL) return;
  SYNC_POLL = setTimeout(async function tick() {
    SYNC_POLL = null;
    if (S.page !== "devices" || DEV.id) return;
    const sy = await call("sync_status").catch(() => null);
    const card = document.getElementById("sync-sec");
    if (!sy || !card) return;
    if (!sy.running && !DS.busy) return renderDevices();
    card.outerHTML = syncSection(sy);
    bindSync();
    SYNC_POLL = setTimeout(tick, 2000);
  }, 2000);
}

/** 多设备同步：设备页「同步」一组设置行——账号、登录着的设备（点开小弹层，可移除）、立即同步。没登录就引导登录 */
function syncSection(sy) {
  if (sy.shadow) return "";
  const msg = DS.err ? `<div class="mx-field-error">${esc(DS.err)}</div>` : DS.msg ? `<p class="note">${esc(DS.msg)}</p>` : "";
  const row = (name, desc, side) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div>${desc ? `<div class="mx-setting-desc">${desc}</div>` : ""}</div>${side}</div>`;
  const wrap = (rows) => section("同步", `<div class="rows">${rows}</div>${msg}`).replace('<section class="mx-sec"', '<section class="mx-sec" id="sync-sec"');
  if (!sy.configured) return wrap(row("多设备同步", "登录后，多台设备的记录会同步",
    `<span class="mx-status">没登录</span><span class="btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-signup">注册</button><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-login">登录</button></span>`));
  if (!sy.email) return wrap(row("多设备同步", "旧版配对码账号，设好邮箱和主密码就能在别的设备登录",
    `<span class="mx-status mx-status--warn">要设账号</span><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-claim">设好账号</button>`));
  if (sy.need_login) return wrap(row("多设备同步", "登录已失效，重新登录后接着同步",
    `<span class="mx-status mx-status--warn">要重新登录</span><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ac-login">重新登录</button>`));
  const sessions = (DS.account && DS.account.sessions) || [];
  const pg = sy.progress || {};
  const busy = sy.running || DS.busy;
  const going = busy && pg.phase && pg.total > 0;
  const bar = going ? `<div class="sync-prog"><div class="sync-prog-text"><span>${pg.phase === "upload" ? "上传" : "下载"}</span><span class="mono">${numText(pg.done)} / ${numText(pg.total)} 段</span></div><div class="bar"><i style="width:${Math.min(100, Math.round((pg.done / pg.total) * 100))}%"></i></div></div>` : "";
  const state = busy ? `<span class="mx-status">同步中…</span>` : sy.last_error ? `<span class="mx-status mx-status--warn">上次有错</span>` : `<span class="mx-status mx-status--ok">已开${sy.last ? ` · 上次 ${ymdhm(sy.last)}` : ""}</span>`;
  return wrap(row("账号", esc(sy.email), state)
    + (bar ? `<div class="sync-bar-row">${bar}</div>` : "")
    + (sy.last_error ? `<div class="mx-error">${esc(sy.last_error)}</div>` : "")
    + (sessions.length ? row("登录着的设备", "", `<button class="mx-btn mx-btn--text mx-btn--sm" id="sess-open">${sessions.length} 台${ICON.chevR}</button>`) : "")
    + row("立即同步", sy.uploaded ? `已传 ${numText(sy.uploaded)} 段` : "", `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="sync-now" ${busy ? "disabled" : ""}>立即同步</button>`));
}

/** 登录着这个账号的设备（小弹层）：这台标出来，别的可以移除（先点「移除」，再点一次确认） */
function sessionsDialog() {
  let removing = null;
  const body = () => {
    const sessions = (DS.account && DS.account.sessions) || [], me = DS.account && DS.account.session;
    return `<div class="sess">${sessions.map((x) => `<div class="sess-row"><span>${esc((DS.names || {})[x.device] || x.name || x.device)}${x.id === me ? `<span class="mx-tag">这台</span>` : ""}</span><span class="note">最近 ${mdhm(new Date(x.last_seen).toISOString())}</span>${x.id === me ? "<span></span>" : removing === x.id
      ? `<span class="btns"><button class="mx-btn mx-btn--text mx-btn--sm" data-sess-keep>取消</button><button class="mx-btn mx-btn--danger mx-btn--sm" data-sess-go="${esc(x.id)}">移除</button></span>`
      : `<button class="mx-btn mx-btn--text mx-btn--sm" data-sess="${esc(x.id)}">移除</button>`}</div>`).join("")}</div>
      <p class="note">移除后，那台设备要重新登录才能再同步，它已经传上来的记录还在。</p>`;
  };
  const d = openDialog({ title: "登录着这个账号的设备", body: `<div id="sess-body">${body()}</div>`, cancel: "关闭", ok: null,
    onOpen: (el) => {
      const draw = () => { el.querySelector("#sess-body").innerHTML = body(); bind(); };
      const bind = () => {
        el.querySelectorAll("[data-sess]").forEach((b) => (b.onclick = () => { removing = b.dataset.sess; draw(); }));
        el.querySelectorAll("[data-sess-keep]").forEach((b) => (b.onclick = () => { removing = null; draw(); }));
        el.querySelectorAll("[data-sess-go]").forEach((b) => (b.onclick = async () => {
          try { await call("account_remove_device", { id: b.dataset.sessGo }); DS.account = await call("account_info").catch(() => DS.account); DS.msg = "已移除，那台设备要重新登录"; }
          catch (x) { DS.err = String(x); }
          removing = null; draw(); if (S.page === "devices" && !DEV.id) renderDevices();
        }));
      };
      bind();
    } });
  return d;
}

function bindSync() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("ac-login", () => loginDialog("login"));
  on("ac-signup", () => loginDialog("signup"));
  on("ac-claim", claimDialog);
  on("sess-open", sessionsDialog);
  on("sync-now", async () => { DS.busy = true; DS.err = DS.msg = null; renderDevices(); try { const r = await call("sync_now"); DS.msg = `上传 ${r.uploaded} 段，下载 ${r.downloaded} 段${r.errors.length ? "，有错：" + r.errors.join("；") : ""}`; } catch (x) { DS.err = String(x); } DS.busy = false; renderDevices(); });
}

// ---------- 设置 ----------

const THEMES = [["", "跟随系统"], ["light", "浅色"], ["dark", "深色"]];
const SETTING_KEYS = ["gateway", "model_segment", "repo_path", "blocklist", "relay_server"];
const same = (a, b) => JSON.stringify(SETTING_KEYS.map((k) => a[k])) === JSON.stringify(SETTING_KEYS.map((k) => b[k]));
/** Windows 版：没有钥匙串和系统授权（密钥存数据目录，采集不用授权） */
const IS_WIN = /Windows/.test(navigator.userAgent);
const KEY_SOURCE = { keychain: "已存（钥匙串）", file: "已存（数据目录）", env: "在用环境变量里的" };
const KEY_STORE = IS_WIN ? "数据目录" : "钥匙串";
const DELETES = [["15", "最近 15 分钟"], ["60", "最近 1 小时"], ["today", "今天全部"]];
const SS = { deleting: null, deleted: null, advanced: false };
/** 项目列表（设置页进来时取一次，改过后重取） */
const PJ = { err: null, list: null };

function profileRow() {
  const pf = S.profile || { name: "我" };
  const identity = `<div class="profile"><span class="avatar big">${avatarHtml(pf)}</span><div><div class="mx-setting-name">${esc(pf.name)}</div><div class="mx-setting-desc">${pf.email ? esc(pf.email) : "显示在左下角"}</div></div></div>`;
  if (ANDROID) return `<div class="profile-setting">${identity}<button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-edit">更改</button></div>`;
  return `<div class="mx-setting">${identity}<button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-edit">编辑</button></div>`;
}

/** 选的图片居中裁成方的、缩到 128 像素，转成 JPEG data URL */
function shrinkImage(file) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height), c = document.createElement("canvas");
      c.width = c.height = 128;
      c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 128, 128);
      ok(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => fail("读不了这张图片");
    img.src = URL.createObjectURL(file);
  });
}

/** 编辑头像和名称（小弹层）。avatar：undefined＝没动，null＝改用名字首字 */
function profileDialog() {
  const pf = S.profile || { name: "我" };
  let avatar;
  openDialog({
    title: "编辑个人资料", ok: "保存",
    body: ANDROID
      ? `${dlgField("pf-name", "名称", { value: pf.name || "", help: "修改后会同步到侧栏和设备记录" })}`
      : `<div class="profile"><span class="avatar big" id="pf-av">${avatarHtml(pf)}</span><div class="btns sync-btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="pf-pick">换头像</button><button class="mx-btn mx-btn--text mx-btn--sm" id="pf-clear">用名字首字</button><input type="file" id="pf-file" accept="image/*" hidden></div></div>${dlgField("pf-name", "名称", { value: pf.name || "", help: "" })}`,
    onOpen: (el, d) => {
      const name = el.querySelector("#pf-name"); name.maxLength = 40;
      if (ANDROID) return;
      const av = el.querySelector("#pf-av"), file = el.querySelector("#pf-file");
      const show = () => (av.innerHTML = avatarHtml({ name: name.value.trim() || pf.name, avatar: avatar === undefined ? pf.avatar : avatar }));
      name.oninput = show;
      el.querySelector("#pf-pick").onclick = () => file.click();
      el.querySelector("#pf-clear").onclick = () => { avatar = null; show(); };
      file.onchange = async () => { if (!file.files[0]) return; try { avatar = await shrinkImage(file.files[0]); d.setErr(null); show(); } catch (x) { d.setErr(String(x)); } };
    },
    submit: async (el) => {
      const name = dlgVal(el, "pf-name");
      if (!name) throw "名称不能空。";
      await call("save_profile", { name, avatar: ANDROID ? null : (avatar === undefined ? pf.avatar || null : avatar) });
      S.profile = await call("get_profile"); renderSide(); renderSettings();
    },
  });
}

function bindProfile() {
  const b = document.getElementById("pf-edit");
  if (b) b.onclick = profileDialog;
}

const DOMAINS = ["工作", "成长", "生活", "健康", "关系", "休闲"];

function projectsSection() {
  const list = PJ.list || [];
  const dur = (sec) => (sec < 3600 ? Math.round(sec / 60) + " 分钟" : hh(sec) + " 小时");
  if (!list.length) return section("项目", `<p class="note">项目来自 10 分钟摘要中的模型标注。当前还没有带项目标签的摘要，先使用一段时间后会自动出现；也可以先设置模型。</p>`);
  const byDom = DOMAINS.map((d) => [d, list.filter((p) => p.domain === d)]).filter(([, xs]) => xs.length);
  const rows = byDom.map(([d, xs]) => `<div class="pj-group">${d}</div>` + xs.map((p) => `<div class="pj-row" data-p="${esc(p.name)}">
      <div class="pj-main"><div class="mx-setting-name">${esc(p.name)}</div><div class="mx-setting-desc">累计 ${dur(p.sec)}${p.aliases.length ? ` · 也叫 ${esc(p.aliases.join("、"))}` : ""}</div></div>
      <button class="mx-btn mx-btn--text mx-btn--sm" data-pj-edit>编辑</button></div>`).join("")).join("");
  return section("项目", `<p class="note">项目由摘要自动判断，你改过的不会被覆盖</p><div class="pj">${rows}</div>${PJ.err ? `<div class="mx-field-error">${esc(PJ.err)}</div>` : ""}`);
}

/** 编辑一个项目（小弹层）：改领域，或者合并到另一个项目 */
function projectDialog(p) {
  const others = (PJ.list || []).filter((q) => q.name !== p.name);
  const why = "同一件事的两个叫法，合并成一个";
  let domain = p.domain, into = "";
  openDialog({
    title: `编辑「${p.name}」`, ok: "保存",
    body: `<div class="mx-field" id="pj-dom-f"><label>领域</label><div class="mx-seg" role="tablist" id="pj-dom">${DOMAINS.map((x) => `<button role="tab" aria-selected="${x === domain}" class="${x === domain ? "is-on" : ""}" data-v="${x}">${x}</button>`).join("")}</div></div>
      ${others.length ? `<div class="mx-field"><label>合并到</label><div class="pick-list" role="listbox" id="pj-into"><button role="option" aria-selected="true" data-v=""><span>不合并</span>${ICON.check}</button>${others.map((q) => `<button role="option" aria-selected="false" data-v="${esc(q.name)}"><span>${esc(q.name)}</span><span class="mx-menu-val">${esc(q.domain)}</span>${ICON.check}</button>`).join("")}</div>
        <p class="note" id="pj-why">${why}</p></div>` : ""}`,
    onOpen: (el, d) => {
      el.querySelector("#pj-dom").onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        domain = b.dataset.v;
        el.querySelectorAll("#pj-dom button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); });
      };
      const lst = el.querySelector("#pj-into"); if (!lst) return;
      lst.onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        into = b.dataset.v;
        lst.querySelectorAll("button").forEach((x) => x.setAttribute("aria-selected", x === b));
        el.querySelector("#pj-why").textContent = into ? `记成「${p.name}」的时间都算到「${into}」` : why;
        el.querySelector("#pj-dom-f").hidden = !!into;
        d.setOk(into ? `合并到「${into}」` : "保存");
      };
    },
    submit: async () => {
      if (into) await call("merge_project", { from: p.name, into });
      else if (domain !== p.domain) await call("set_project_domain", { project: p.name, domain });
      else return;
      PJ.err = null; PJ.list = await call("list_projects"); renderSettings();
    },
  });
}

function bindProjects() {
  $app.querySelectorAll("[data-pj-edit]").forEach((b) => (b.onclick = () => projectDialog(PJ.list.find((p) => p.name === b.closest("[data-p]").dataset.p))));
}

/** 账号：msg＝页面上留一句结果；confirmLogout＝退出登录等确认。登录、注册、改密码这些都在小弹层里 */
const AC = { msg: null, confirmLogout: false };

function accountSection(sy) {
  return section("账号", profileRow() + accountBody(sy));
}

function accountBody(sy) {
  const msg = AC.msg ? `<p class="note ac-msg">${esc(AC.msg)}</p>` : "";
  const row = (name, desc, right) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>${right}</div>`;
  const btn = (id, text) => `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="${id}">${text}</button>`;
  if (sy.configured && sy.email && !sy.need_login) return row(esc(sy.email), "别的设备用这个邮箱登录",
      AC.confirmLogout ? `<div class="btns"><button class="mx-btn mx-btn--text mx-btn--sm" id="logout-keep">取消</button><button class="mx-btn mx-btn--danger mx-btn--sm" id="logout-go">退出登录</button></div>` : btn("ac-logout", "退出登录"))
    + row("主密码", "只在设备上用，不会发给服务器。", btn("ac-password", "改主密码"))
    + row("恢复码", "忘了主密码时用它重设。", btn("ac-show-code", "查看")) + msg;
  if (sy.configured && !sy.email) return row("邮箱和主密码", "旧版配对码账号，设好邮箱和主密码就能在别的设备登录", btn("ac-claim", "设好账号")) + msg;
  return row(sy.need_login ? "登录已失效" : "没登录",
    sy.need_login ? "登录已失效，重新登录后接着同步" : "登录后，多台设备的记录会同步",
    `<div class="btns">${sy.need_login ? "" : btn("ac-signup", "注册")}${btn("ac-login", sy.need_login ? "重新登录" : "登录")}</div>`) + msg;
}

const checkEmail = (e) => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw "邮箱格式不对。";
  // 常见手滑：.con、gmial 这类，邮箱错了以后登录不上
  if (/\.(con|cmo|cm|comm|om|vom|xom)$/i.test(e) || /@(gmial|gamil|gmai|gmal|gmaill|qq\.con)\b/i.test(e)) throw "邮箱像是拼错了，检查一下";
  return e;
};
const checkPw = (el) => {
  const a = el.querySelector("#pw1").value, b = el.querySelector("#pw2");
  if (a.length < 8) throw "主密码至少 8 位。";
  if (b && b.value !== a) throw "两次输入的主密码不一样。";
  return a;
};
/** 账号变了：登录着的设备列表重取，当前页重画（设置页和设备页都能开这些弹层） */
const accountChanged = () => { DS.account = null; return S.page === "devices" ? renderDevices() : renderSettings(); };

/** 登录、注册、用恢复码重设（小弹层，底下可以互相切换） */
function loginDialog(mode = "login", email = "") {
  const sy = S.sync || {};
  const em = dlgField("em", "邮箱", { ph: "you@example.com", value: email || sy.email || "" });
  const pw2 = dlgField("pw2", "再输一次", { type: "password" });
  const forms = {
    login: ["登录", em + dlgField("pw1", "主密码", { type: "password" }), "登录", "登录中…"],
    signup: ["注册", em + dlgField("pw1", "主密码", { type: "password", ph: "至少 8 位，记得住又别人猜不到" }) + pw2 + dlgField("inv", "邀请码", { type: "password", ph: "现在注册要邀请码" }), "注册并登录", "注册中…"],
    recover: ["用恢复码重设主密码", em + dlgField("rc", "恢复码", { ph: "XXXX-XXXX-…", mono: true }) + dlgField("pw1", "新主密码", { type: "password", ph: "至少 8 位" }) + pw2, "重设并登录", "重设中…"],
  };
  const links = { login: [["signup", "没有账号？注册"], ["recover", "忘了主密码"]], signup: [["login", "已经有账号？登录"]], recover: [["login", "想起来了？登录"]] }[mode];
  const [title, body, ok, busy] = forms[mode];
  openDialog({
    title, ok, busy,
    body: (mode === "recover" ? `<p class="note">重设后，其他设备要重新登录</p>` : `<p class="note">记录在本机加密后再同步，服务器读不到内容</p>`) + body
      + `<div class="dlg-links">${links.map(([k, v]) => `<button class="mx-btn mx-btn--text mx-btn--sm" data-to="${k}">${v}</button>`).join("")}</div>`,
    onOpen: (el) => el.querySelectorAll("[data-to]").forEach((b) => (b.onclick = () => loginDialog(b.dataset.to, dlgVal(el, "em")))),
    submit: async (el) => {
      const email = checkEmail(dlgVal(el, "em"));
      AC.msg = null;
      if (mode === "login") await call("account_login", { email, password: el.querySelector("#pw1").value });
      else if (mode === "signup") { const code = await call("account_signup", { invite: dlgVal(el, "inv"), email, password: checkPw(el) }); setTimeout(() => codeDialog(code, true)); }
      else { await call("account_recover", { email, code: dlgVal(el, "rc"), password: checkPw(el) }); AC.msg = "已重设，其他设备要重新登录"; }
      accountChanged();
    },
  });
}

/** 早期配对码账号设邮箱和主密码 */
function claimDialog() {
  openDialog({
    title: "设邮箱和主密码", ok: "设好账号", busy: "设置中…",
    body: `<p class="note">设好后，别的设备用邮箱和主密码登录</p>`
      + dlgField("em", "邮箱", { ph: "you@example.com" }) + dlgField("pw1", "主密码", { type: "password", ph: "至少 8 位，记得住又别人猜不到" }) + dlgField("pw2", "再输一次", { type: "password" }),
    submit: async (el) => {
      const email = checkEmail(dlgVal(el, "em")), code = await call("account_claim", { email, password: checkPw(el) });
      AC.msg = null; accountChanged(); setTimeout(() => codeDialog(code, true));
    },
  });
}

function passwordDialog() {
  openDialog({
    title: "改主密码", ok: "改主密码", busy: "改密码中…",
    body: `<p class="note">以后登录新设备用新主密码</p>`
      + dlgField("pw1", "新主密码", { type: "password", ph: "至少 8 位" }) + dlgField("pw2", "再输一次", { type: "password" }),
    submit: async (el) => { await call("account_password", { password: checkPw(el) }); AC.msg = "主密码已改。"; renderSettings(); },
  });
}

/** 恢复码。fresh＝刚注册或刚设好账号：必须点「我已存好」才关 */
function codeDialog(code, fresh) {
  openDialog({
    title: fresh ? "存好恢复码" : "恢复码", closable: !fresh, cancel: fresh ? false : "关闭", ok: fresh ? "我已存好" : "复制恢复码",
    body: `<div class="code-box"><code class="mono">${esc(code)}</code>${fresh ? `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="copy-rc" autofocus>复制</button>` : ""}</div>
      <p class="note warn-text">恢复码是忘了主密码时找回数据的唯一办法：存进密码管理器或抄在纸上。主密码和恢复码都丢了，云端的数据就再也解不开，我们也帮不了。</p>`,
    onOpen: (el, d) => {
      const b = el.querySelector("#copy-rc");
      if (b) b.onclick = async () => { try { await navigator.clipboard.writeText(code); b.textContent = "已复制"; } catch (x) { d.setErr("复制不了，手动选中复制。"); } };
    },
    submit: async () => { if (!fresh) { try { await navigator.clipboard.writeText(code); } catch (x) { throw "复制不了，手动选中复制。"; } } },
  });
}

function bindAccount() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("ac-login", () => loginDialog("login"));
  on("ac-signup", () => loginDialog("signup"));
  on("ac-claim", claimDialog);
  on("ac-password", passwordDialog);
  on("ac-show-code", async () => { try { codeDialog(await call("account_recovery_code"), false); } catch (x) { AC.msg = `取不到恢复码：${x}`; renderSettings(); } });
  on("ac-logout", () => { AC.confirmLogout = true; renderSettings(); });
  on("logout-keep", () => { AC.confirmLogout = false; renderSettings(); });
  on("logout-go", async () => { await call("account_logout"); AC.confirmLogout = false; AC.msg = null; DS.account = null; renderSettings(); });
}

/** 到明早 8 点还有几分钟 */
function minutesToMorning() {
  const now = new Date(), t = new Date(now);
  t.setHours(8, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return Math.ceil((t - now) / 60000);
}

// ---------- 设置：地图（高德 Key、常去的地方） ----------

const PL = { labels: [] };
const PL_TYPES = [["home", "家"], ["work", "工作"], ["other", "其他"]];
const PL_ICON = { home: "家", work: "工作" };

/** 改了常去的地方以后：在哪一页就重画哪一页 */
const afterPlaces = () => (S.page === "settings" ? renderSettings() : renderToday());

/** 改常去的地方里的一项：名字、地址、种类、范围；名字清空＝删掉 */
async function labelDialog(i) {
  PL.labels = await call("list_place_labels").catch(() => PL.labels);
  const l = PL.labels[i]; if (!l) return;
  let kind = l.type || "other", r = Math.round(l.r || 150);
  const seg = (id, items, cur) => `<div class="mx-seg" role="tablist" id="${id}">${items.map(([k, t]) => `<button role="tab" aria-selected="${String(k) === String(cur)}" class="${String(k) === String(cur) ? "is-on" : ""}" data-v="${k}">${t}</button>`).join("")}</div>`;
  openDialog({
    title: `改「${l.label}」`, ok: "保存",
    body: dlgField("pl-n", "名字", { value: l.label, help: "清空就删掉这个地方。" })
      + dlgField("pl-a", "地址", { value: l.address || "", ph: "比如 某某小区 3 幢" })
      + `<div class="mx-field"><label>种类</label>${seg("pl-k", PL_TYPES, kind)}</div>`
      + `<div class="mx-field"><label>范围</label>${seg("pl-r", [[100, "100 米"], [150, "150 米"], [250, "250 米"], [400, "400 米"]], r)}<p class="note">离得近的两个地方，范围别重叠</p></div>`,
    onOpen: (el) => {
      const bindSeg = (id, set) => { el.querySelector("#" + id).onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; set(b.dataset.v); el.querySelectorAll(`#${id} button`).forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); }); }; };
      bindSeg("pl-k", (v) => (kind = v)); bindSeg("pl-r", (v) => (r = +v));
    },
    submit: async (el) => { await call("edit_place_label", { index: i, label: dlgVal(el, "pl-n"), kind, r, address: dlgVal(el, "pl-a") || null }); afterPlaces(); },
  });
}

/** 添加一个常去的地方：搜高德（以第一个常去的地方为中心，按距离），挑一个就加上，名字先用店名，之后可以改 */
function addPlaceDialog() {
  const c = PL.labels[0];
  let found = [];
  openDialog({
    title: "添加一个地方", cancel: "关闭",
    body: `<div class="mx-field"><label for="pa-q">搜小区、楼栋、店名、公司</label><input class="mx-input" id="pa-q" autocomplete="off"><div class="pick-list" id="pa-list"></div></div>`,
    onOpen: (el, d) => {
      let timer = null;
      el.querySelector("#pa-q").oninput = (e) => {
        clearTimeout(timer);
        const q = e.target.value.trim(), box = el.querySelector("#pa-list");
        if (!q) { box.innerHTML = ""; return; }
        timer = setTimeout(async () => {
          try { found = await call("amap_search", { text: q, lat: c ? c.lat : null, lon: c ? c.lon : null }); }
          catch (x) { box.innerHTML = `<p class="note">${esc(String(x))}</p>`; return; }
          if (el.querySelector("#pa-q").value.trim() !== q) return;
          box.innerHTML = found.slice(0, 8).map((p, i) => `<button class="pick-row" data-add="${i}"><span class="pk-n">${esc(p.name)}<span class="pk-t">${esc((p.type || "").split(";")[1] || "")}</span></span><span class="pk-r mono">${c && p.distance != null ? (p.distance < 1000 ? Math.round(p.distance) + " 米" : (p.distance / 1000).toFixed(1) + " 公里") : ""}</span></button>`).join("") || `<p class="note">没搜到。</p>`;
        }, 350);
      };
      el.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-add]"); if (!b) return;
        const p = found[+b.dataset.add];
        try { await call("set_place_label", { lat: p.lat, lon: p.lon, label: shopShort(p.name), kind: "other" }); closeDialog(); afterPlaces(); }
        catch (x) { d.setErr(`没加上：${x}`); }
      });
    },
  });
}

/** 设置分六页，放在页头的页签里：通用｜账号｜记录｜连接｜数据｜项目。改了就存，不再有「保存设置」；要填几项的（地址、模型、密钥）开小弹层 */
const SET_TABS = [["general", "通用"], ["account", "账号"], ["record", "记录"], ["connect", "连接"], ["data", "数据"], ["projects", "项目"]];
const setRow = (name, desc, right) => { const cls = ANDROID && typeof name === "string" && name.includes("android-setting-label") ? " android-setting-row" : ""; return `<div class="mx-setting${cls}"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div>${desc ? `<div class="mx-setting-desc">${desc}</div>` : ""}</div>${right}</div>`; };
const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return u || ""; } };
const smallBtn = (id, text, attrs = "") => `<button class="mx-btn mx-btn--secondary mx-btn--sm" id="${id}" ${attrs}>${text}</button>`;
const pill = (ok, text) => `<span class="mx-status mx-status--${ok ? "ok" : "warn"}">${text}</span>`;
/** 只改几个键：save_settings 只写传进去的键 */
async function saveSome(part) {
  await call("save_settings", { settings: part });
  if (ANDROID && window.AndroidBridge && typeof window.AndroidBridge.refreshSettings === "function") window.AndroidBridge.refreshSettings();
  S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings));
}
const isUrl = (v) => /^https?:\/\/\S+$/.test(v);
const KEEP = "已存，留空不改";

async function renderSettings() {
  if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
  // 手机版不采集：没有「记录」页（暂停、不记录的 app、删最近记录都是电脑上的事）
  const tabsHere = S.status && S.status.mobile ? SET_TABS.filter(([k]) => k !== "record") : SET_TABS;
  const tab = tabsHere.some(([k]) => k === SS.tab) ? SS.tab : "general";
  const sy = await call("sync_status").catch(() => ({}));
  S.sync = sy;
  if (tab === "projects") PJ.list = PJ.list || await call("list_projects").catch(() => []);
  S.profile = await call("get_profile").catch(() => S.profile);
  S.status = await call("get_status");
  if (TAURI) S.update = await call("update_status").catch(() => S.update);
  renderSide();
  const st = S.status, cf = S.settings;
  const theme = document.documentElement.dataset.theme || "";
  const tabs = `<div class="toolbar"><div class="toolbar-left"><div class="tabs" role="tablist" id="set-tabs">${tabsHere.map(([k, v]) =>
    `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? "is-on" : ""}" data-st="${k}">${v}</button>`).join("")}</div></div></div>`;

  let body = "";
  if (tab === "general") {
    const mobile = !!st.mobile;
    body = section("个人资料", profileRow())
      + (mobile ? (ANDROID ? androidPermissionSection() : phoneSection()) : "")
      + section("通用", (mobile ? (ANDROID ? androidBackgroundRows(cf) : "") : setRow("开机自动启动", "登录电脑后自动开始记录。", `<button class="mx-switch" role="switch" id="login" aria-checked="${!!st.login_item}" aria-label="开机自动启动"></button>`))
        + setRow("主题", "", `<div class="mx-seg" role="tablist" id="theme">${THEMES.map(([k, v]) => `<button role="tab" aria-selected="${k === theme}" class="${k === theme ? "is-on" : ""}" data-theme="${k}">${v}</button>`).join("")}</div>`))
      + (mobile ? section("关于", setRow(`版本 ${esc(st.version || "")}`, "手机版版本。", "")) : aboutSection());
  } else if (tab === "account") {
    body = sy.shadow ? section("账号", emptyInline("测试版不登录账号")) : section("账号与同步", accountBody(sy));
  } else if (tab === "record") {
    const pause = st.paused
      ? setRow("已暂停", st.paused_until ? `到 ${hm(st.paused_until)} 自动继续。` : "一直暂停，点继续才恢复。", `<button class="mx-btn mx-btn--primary mx-btn--sm" data-pause="off">继续记录</button>`)
      : setRow("暂停记录", "暂停后不记录", `<div class="btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" data-pause="60">1 小时</button><button class="mx-btn mx-btn--secondary mx-btn--sm" data-pause="morning">到明早 8 点</button><button class="mx-btn mx-btn--secondary mx-btn--sm" data-pause="on">一直</button></div>`);
    const block = `<div class="block"><div><div class="mx-setting-name">不记录的 app</div><div class="mx-setting-desc">在前台时只记用了多久，不记内容。</div></div>
        ${cf.blocklist.length ? `<div class="mx-chips" id="chips">${cf.blocklist.map((b, i) => `<button class="mx-chip" data-i="${i}" title="移出">${esc(b)}${ICON.close}</button>`).join("")}</div>` : ""}
        <div class="inline"><input class="mx-input mono" id="block-new" placeholder="app 名或 bundle id，比如 1Password" aria-label="不记录的 app"><button class="mx-btn mx-btn--secondary" id="block-add">加入</button></div></div>`;
    const del = SS.deleting
      ? `<div class="mx-confirm"><div class="mx-confirm-text"><b>删除${DELETES.find((x) => x[0] === SS.deleting)[1]}的记录？</b><span>删了找不回来。</span></div><button class="mx-btn mx-btn--secondary" data-del="keep">取消</button><button class="mx-btn mx-btn--danger" data-del="go">删除</button></div>`
      : setRow("删除最近的记录", SS.deleted != null ? `刚删掉 ${SS.deleted} 条。` : "比如刚输过的私人内容。", `<div class="btns">${DELETES.map(([k, v]) => `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-del="${k}">${v}</button>`).join("")}</div>`);
    body = section("记录", pause + block) + section("隐私", del);
  } else if (tab === "connect") {
    const ks = cf.api_key_source;
    const amap = cf.has_amap_key && cf.has_amap_js ? pill(true, "已存") : cf.has_amap_key ? pill(false, "缺地图 Key") : pill(false, "还没有");
    const syncLocked = sy.configured && !sy.shadow;
    const L = SS.llm || {};
    const official = cf.model_mode === "official", asrOfficial = cf.transcribe_server === cf.default_transcribe_server, mapOfficial = cf.map_mode === "official";
    const planPill = L.error ? pill(false, "没登录账号") : L.plan === "official" ? pill(true, "已开通") : L.plan === "stopped" ? pill(false, "已停用") : SS.llm ? pill(false, "没开通") : "";
    // 三项本月用量：用了多少 / 上限，进度条；这一项改成自己的就写「用的是自己的」
    const useRow = (name, u, using, fmt) => {
      const used = (u && u.used) || 0, q = (u && u.quota) || 0;
      const pct = q ? Math.min(100, Math.round(used / q * 100)) : 0;
      return setRow(name, `${fmt(used)} / ${q ? fmt(q) : "不限"}${using ? "" : " · 这一项用的是自己的"}<div class="usebar"><i style="width:${pct}%"${pct >= 90 ? ' class="hot"' : ""}></i></div>`, `<span class="note mono">${q ? pct + "%" : ""}</span>`);
    };
    const tokens = (n) => (n >= 1e4 ? `${numText(Math.round(n / 1e4))} 万 token` : `${numText(n)} token`);
    const minutes = (sec) => `${numText(Math.round(sec / 60))} 分钟`;
    const calls = (n) => `${numText(n)} 次`;
    body = section("官方服务", setRow("这个账号", L.plan === "official" ? "模型、转写、地图都用官方的，不用填 Key" : L.plan === "stopped" ? "已停用，联系管理员" : L.error ? "登录后才能用" : "还没开通，联系管理员", planPill)
        + (L.plan === "official" ? useRow("模型", L.llm, official, tokens) + useRow("转写", L.asr, asrOfficial, minutes) + useRow("地图", L.map, mapOfficial, calls) : ""))
      + section("每一项", (official
      ? setRow("模型", "官方", smallBtn("c-model", "设置"))
      : setRow("模型", `自己的网关 · <span class="mono">${esc(hostOf(cf.gateway))} · ${esc(cf.model_segment || "没填模型")}</span>${modelSyncHint(cf)}`, `${pill(!!ks, ks ? "密钥已存" : "没有密钥")}${smallBtn("c-model", "设置")}`))
      + setRow("转写服务", `${asrOfficial ? "官方" : `自建 · <span class="mono">${esc(hostOf(cf.transcribe_server))}</span>`} · 你叫「${esc(cf.speaker_name)}」${st.cloud_sync ? `<br>${esc(st.cloud_sync)}` : ""}`, smallBtn("c-asr", "设置"))
      + setRow("高德地图", mapOfficial ? "官方" : "自己的 Key", `${mapOfficial ? "" : amap}${smallBtn("c-amap", "设置")}`)
      + setRow("同步服务器", `<span class="mono">${esc(hostOf(cf.sync_server))}</span>${cf.sync_server === cf.default_sync_server ? " · 官方" : " · 自建"}`, smallBtn("c-sync", "更改", syncLocked ? `disabled title="登录着不能换，先在「账号」里退出"` : ""))
      );
  } else if (tab === "data") {
    body = SS.storage ? storageView(SS.storage) : `<div class="form">${emptyInline("在看数据存在哪……")}</div>`;
  } else {
    body = projectsSection();
  }
  $app.innerHTML = header("设置") + tabs + `<div class="form">${body}</div>`;

  document.getElementById("set-tabs").onclick = (e) => {
    const b = e.target.closest("[data-st]"); if (!b) return;
    SS.tab = b.dataset.st; try { localStorage.setItem("settings-tab", SS.tab); } catch (x) {}
    renderSettings();
  };
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  if (tab === "general") {
    bindProfile(); if (!st.mobile) bindAbout();
    if (st.mobile) { if (ANDROID) bindAndroidPermissions(); else bindPhone(); }
    document.getElementById("theme").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const t = b.dataset.theme;
      if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
      try { t ? localStorage.setItem("theme", t) : localStorage.removeItem("theme"); } catch (err) {}
      renderSettings();
    };
    on("login", async () => { try { await call("set_login_item", { on: !st.login_item }); } catch (x) { alert(`没改成：${x}`); } renderSettings(); });
    // Android 两个后台开关：直接存设置，服务每分钟读一次就生效，不用重启
    on("hide-ongoing", async () => { await saveSome({ hide_ongoing: !cf.hide_ongoing }); renderSettings(); });
    on("hide-recents", async () => { await saveSome({ hide_recents: !cf.hide_recents }); renderSettings(); });
    on("keep-alive", async () => { await saveSome({ keep_alive: cf.keep_alive === false }); renderSettings(); });
  }
  if (tab === "account" && !sy.shadow) bindAccount();
  if (tab === "projects") bindProjects();
  if (tab === "record") {
    $app.querySelectorAll("[data-pause]").forEach((b) => (b.onclick = async () => {
      const k = b.dataset.pause;
      if (k === "off") await call("set_paused", { paused: false });
      else await call("set_paused", { paused: true, minutes: k === "on" ? null : k === "morning" ? minutesToMorning() : +k });
      renderSettings();
    }));
    $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      const k = b.dataset.del;
      if (k === "keep") { SS.deleting = null; return renderSettings(); }
      if (k === "go") {
        const what = SS.deleting; SS.deleting = null;
        SS.deleted = await call("delete_since", what === "today" ? { today: true } : { minutes: +what });
        return renderSettings();
      }
      SS.deleting = k; SS.deleted = null; renderSettings();
    }));
    const setBlock = async (list) => { await saveSome({ blocklist: list }); renderSettings(); };
    const addBlock = () => { const v = document.getElementById("block-new").value.trim(); if (v && !cf.blocklist.includes(v)) setBlock([...cf.blocklist, v]); };
    on("block-add", addBlock);
    document.getElementById("block-new").onkeydown = (e) => { if (e.key === "Enter") addBlock(); };
    const chips = document.getElementById("chips");
    if (chips) chips.onclick = (e) => { const b = e.target.closest("[data-i]"); if (b) setBlock(cf.blocklist.filter((_, i) => i !== +b.dataset.i)); };
  }
  clearInterval(SS.storageTimer);
  if (tab === "data") {
    const load = async () => {
      try { SS.storage = await call("storage_stats"); } catch (x) { SS.storage = { error: String(x) }; }
      if (S.page === "settings" && SS.tab === "data" && !document.querySelector(".dlg-root")) renderSettings();
    };
    if (!SS.storage || Date.now() - (SS.storage.at || 0) > 60e3) load();
    SS.storageTimer = setInterval(load, 60e3);
    on("open-dir", () => call("open_data_dir"));
    on("repo-edit", () => openDialog({
      title: "人生记录仓库", ok: "保存",
      body: dlgField("repo", "路径", { value: cf.repo_path || "", mono: true, ph: "~/人生记录", help: "日数据包和日总结的文件夹" }),
      submit: async (el) => { await saveSome({ repo_path: dlgVal(el, "repo") }); renderSettings(); },
    }));
  }
  if (tab === "connect") {
    if (!SS.llmLoading && (!SS.llm || Date.now() - SS.llmAt > 60e3)) {
      SS.llmLoading = true;
      call("llm_status").then((v) => { SS.llm = v; SS.llmAt = Date.now(); }).catch((x) => { SS.llm = { error: String(x) }; })
        .finally(() => { SS.llmLoading = false; if (S.page === "settings" && SS.tab === "connect" && !document.querySelector(".dlg-root")) renderSettings(); });
    }
    on("c-model", modelDialog);
    on("c-asr", asrDialog);
    on("c-amap", amapDialog);
    on("c-sync", syncServerDialog);
  }
}

/** Android 设置里的采集权限：状态由原生桥读取，点击后跳到对应系统页。 */
function androidPermissionSection() {
  const p = SS.androidPermissions;
  if (!p) return section("这台手机", emptyInline("在看权限状态……"));
  if (p.error) return section("这台手机", `<div class="mx-field-error">${esc(p.error)}</div>`);
  const rows = [["accessibility", "无障碍", "读取正在看的界面文字，生成语义摘要主要靠它"], ["usage", "使用情况访问", "记录每个 app 用了多久、什么时候在前台"], ["notifications", "通知使用权", "记录谁来找过你；正文默认不记"], ["battery", "电池优化白名单", "避免息屏后后台被冻结、记录断档"], ["auto_start", "自启动", "国产 ROM 需要在系统设置里放行"]];
  return section("这台手机", rows.map(([key, name, desc]) => {
    const known = typeof p[key] === "boolean";
    const ok = known && p[key];
    const text = key === "auto_start" ? "需按手机品牌设置，无法自动读取" : (ok ? "已授权" : "未授权");
    const action = (!ok || key === "auto_start") ? smallBtn(`android-perm-${key}`, "去设置") : "";
    return setRow(androidSettingLabel(key, name), desc, `${pill(ok, text)}${action}`);
  }).join(""));
}
function bindAndroidPermissions() {
  const load = () => {
    try { SS.androidPermissions = JSON.parse(window.AndroidBridge.permissions()); }
    catch (x) { SS.androidPermissions = { error: String(x) }; }
    if (S.page === "settings" && SS.tab === "general" && !document.querySelector(".dlg-root")) renderSettings();
  };
  if (!SS.androidPermAt || Date.now() - SS.androidPermAt > 5e3) { SS.androidPermAt = Date.now(); load(); }
  $app.querySelectorAll("[id^=android-perm-]").forEach((el) => { el.onclick = () => { window.AndroidBridge.openPermission(el.id.slice("android-perm-".length)); }; });
  window.__beayyAndroidResumed = () => { SS.androidPermAt = 0; load(); };
}
/** 手机版设置「通用」里的「这台手机」：定位、手表、用这台 iPhone 录、本人声纹、上传进度（原生做的，经 native_ 命令） */
function phoneSection() {
  const n = SS.native;
  if (!n) return section("这台手机", emptyInline("在看这台手机的状态……"));
  if (n.error) return section("这台手机", `<div class="mx-field-error">${esc(n.error)}</div>`);
  const loc = { always: [true, "始终允许"], when_in_use: [false, "只在使用时"], denied: [false, "没允许"], not_determined: [false, "还没问过"] }[n.location] || [false, n.location];
  const ago = (iso) => (iso ? mdhm(iso) : "还没有");
  return section("这台手机",
    setRow("位置", loc[0] ? (n.precise ? "记停留点用" : "「精确位置」关着，停留点会不准") : "改成「始终」才能记停留点", `${pill(loc[0] && n.precise, loc[1])}${loc[0] && n.precise ? "" : smallBtn("ph-settings", "去设置")}`)
    + setRow("手表", n.watch_recording ? `在录${n.watch_updated ? ` · ${ago(n.watch_updated)} 收到状态` : ""}` : `没在录${n.watch_updated ? ` · ${ago(n.watch_updated)} 收到状态` : ""}`, pill(!!n.watch_recording, n.watch_recording ? "在录" : "没在录"))
    + setRow("用这台 iPhone 录", n.phone_recording ? `在录，${ago(n.phone_since)} 开始` : "没戴手表时用", `<button class="mx-switch" role="switch" id="ph-rec" aria-checked="${!!n.phone_recording}" aria-label="用这台 iPhone 录"></button>`)
    + setRow("本人声纹", "用来认出哪些话是你说的", smallBtn("ph-voice", "录一段", n.logged_in ? "" : "disabled"))
    + setRow("上传", `${n.pending ? `还有 ${n.pending} 段录音` : "录音都传完了"}${n.pending_place_days ? `、${n.pending_place_days} 天停留点` : ""}没传 · 最近 ${ago(n.last_upload)}${n.last_error ? `<br>${esc(n.last_error)}` : ""}${n.logged_in ? "" : "<br>登录账号后开始上传。"}`, smallBtn("ph-up", "现在传")));
}

function bindPhone() {
  const load = async () => {
    try { SS.native = await call("native_status"); } catch (x) { SS.native = { error: String(x) }; }
    if (S.page === "settings" && SS.tab === "general" && !document.querySelector(".dlg-root")) renderSettings();
  };
  if (!SS.nativeAt || Date.now() - SS.nativeAt > 5e3) { SS.nativeAt = Date.now(); load(); }
  const act = (name) => call("native_action", { name }).then(() => setTimeout(() => { SS.nativeAt = 0; renderSettings(); }, 800)).catch((x) => alert(String(x)));
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("ph-settings", () => act("open_settings"));
  on("ph-rec", () => act(SS.native && SS.native.phone_recording ? "record_stop" : "record_start"));
  on("ph-voice", () => act("voiceprint"));
  on("ph-up", () => act("upload_now"));
}

/** 「数据」页：本机、同步服务、转写服务三处各存了什么、多大、留多久（方案见 报告/方案_20261021_录音与存储.md）；开着时每分钟刷新 */
function storageView(d) {
  if (d.error) return section("数据", `<div class="mx-field-error">${esc(d.error)}</div>`);
  const table = (rows, cols) => `<table class="mx-table store"><thead><tr>${cols.map((c) => `<th${c[2] ? ' class="num"' : ""}>${c[0]}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td${c[2] ? ' class="num mono"' : ""}>${c[1](r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  const L = d.local, C = d.cloud, T = d.transcribe;
  const localPath = `<span class="mono storage-path">${esc((L.path || "").replace(/^\/Users\/[^/]+/, "~"))}</span>`;
  const local = section("本机", setRow("数据目录", `${localPath} · 共 ${bytesText(L.total)}`, (S.status && S.status.mobile ? "" : smallBtn("open-dir", "打开目录")))
    + table(L.items, [["内容", (r) => esc(r.name)], ["大小", (r) => bytesText(r.bytes), 1], ["留多久", (r) => esc(r.keep)]]), { aside: "全部数据，以这里为准" });
  const cloud = section("同步服务", C.error ? emptyInline(C.error)
    : `<p class="note" style="margin:0 0 var(--space-3)"><span class="mono">${esc(hostOf(C.server))}</span> · 共 ${bytesText(C.total)}</p>`
      + table(C.items, [["内容", (r) => esc(r.name)], ["块数", (r) => numText(r.count), 1], ["大小", (r) => bytesText(r.bytes), 1], ["留多久", (r) => esc(r.keep)]]));
  const jobs = T.jobs ? Object.entries(T.jobs).map(([k, n]) => `${{ queued: "排队", running: "在转", done: "转好待取", failed: "失败" }[k] || k} ${n}`).join("、") : "";
  const asr = section("转写服务", T.error ? `<p class="note" style="margin:0"><span class="mono">${esc(hostOf(T.server))}</span></p>${emptyInline(T.error)}`
    : setRow(`<span class="mono">${esc(hostOf(T.server))}</span>`, `${jobs || "没有你的任务"} · 占 ${bytesText(T.bytes)}`, `<span class="note">${esc(T.keep)}</span>`));
  const repo = section("人生记录仓库", setRow(d.repo ? `<span class="mono storage-path">${esc((d.repo.path || "").replace(/^\/Users\/[^/]+/, "~"))}</span>` : "没填",
    d.repo ? `raw/ 共 ${bytesText(d.repo.bytes)} · ${esc(d.repo.keep)}` : "日数据包和日总结的文件夹", smallBtn("repo-edit", "更改")));
  return local + cloud + asr + repo + `<p class="note">${d.at ? `${hm(new Date(d.at).toISOString())} 取的，开着这一页每分钟更新。` : ""}</p>`;
}

/** 模型：官方（按账号开通，经同步服务代调，不用填密钥）或自己的网关（地址、模型、密钥；地址和模型有默认值，密钥不预填） */
function modelDialog() {
  const cf = S.settings, ks = cf.api_key_source;
  let mode = cf.model_mode === "official" ? "official" : "custom";
  const L = SS.llm || {};
  const state = L.error ? "要先在「账号」里登录。" : L.plan === "official" ? "这个账号已开通。" : L.plan === "stopped" ? "这个账号的官方服务已停用。" : "这个账号还没开通。";
  openDialog({
    title: "模型", ok: "保存",
    body: `<div class="mx-field"><div class="mx-seg" role="tablist" id="md-mode">${[["official", "官方"], ["custom", "自己的网关"]].map(([k, v]) => `<button role="tab" aria-selected="${k === mode}" class="${k === mode ? "is-on" : ""}" data-v="${k}">${v}</button>`).join("")}</div></div>
      <div id="md-official" ${mode === "official" ? "" : "hidden"}><p class="note">开通后不用填地址和密钥。${esc(state)}</p></div>
      <div id="md-custom" class="stack" ${mode === "custom" ? "" : "hidden"}>`
      + dlgField("gw", "网关地址", { value: cf.gateway, mono: true, ph: cf.default_gateway, help: "兼容 OpenAI 接口，到 /v1 为止" })
      + dlgField("md", "模型", { value: cf.model_segment, mono: true, ph: cf.default_model || "比如 gpt-4.1-mini", help: "10 分钟摘要和日总结都用它。" })
      + dlgField("key", "密钥", { type: "password", mono: true, ph: ks === "env" ? "在用环境变量里的" : ks ? KEEP : "sk-…", help: "" })
      + (cf.default_gateway ? `<button class="mx-btn mx-btn--text mx-btn--sm" style="align-self:flex-start" id="md-reset">恢复默认地址和模型</button>` : "") + `</div>`,
    onOpen: (el) => {
      const r = el.querySelector("#md-reset");
      if (r) r.onclick = () => { el.querySelector("#gw").value = cf.default_gateway; el.querySelector("#md").value = cf.default_model; };
      el.querySelector("#md-mode").onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        mode = b.dataset.v;
        el.querySelectorAll("#md-mode button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); });
        el.querySelector("#md-official").hidden = mode !== "official";
        el.querySelector("#md-custom").hidden = mode !== "custom";
      };
    },
    submit: async (el) => {
      if (mode === "official") { await saveSome({ model_mode: "official" }); SS.llm = null; return renderSettings(); }
      const gw = dlgVal(el, "gw").replace(/\/+$/, ""), md = dlgVal(el, "md"), key = dlgVal(el, "key");
      if (!isUrl(gw)) throw "网关地址要以 https:// 开头，比如 https://api.openai.com/v1";
      if (!md) throw "填一个模型名。";
      await saveSome({ model_mode: "custom", gateway: gw, model_segment: md, model_daily: md });
      if (key) { try { await call("set_api_key", { key }); } catch (x) { throw `地址和模型存好了，密钥没存进去：${x}`; } S.settings = await call("get_settings"); }
      renderSettings();
    },
  });
}

/** 转写服务：地址（默认官方，可换自建）、你在对话里的称呼。认账号用同步服务发的票据，不用另填口令 */
function asrDialog() {
  const cf = S.settings;
  openDialog({
    title: "转写服务", ok: "保存",
    body: dlgField("ta", "地址", { value: cf.transcribe_server, mono: true, ph: cf.default_transcribe_server, help: `官方的是 ${esc(cf.default_transcribe_server)}，也可以填自己搭的` })
      + `<button class="mx-btn mx-btn--text mx-btn--sm" style="align-self:flex-start" id="ta-reset">用官方的</button>`
      + dlgField("tn", "你在对话里叫什么", { value: cf.speaker_name, ph: "我", help: "转写里你说的话标成这个名字" }),
    onOpen: (el) => { el.querySelector("#ta-reset").onclick = () => { el.querySelector("#ta").value = cf.default_transcribe_server; }; },
    submit: async (el) => {
      const a = dlgVal(el, "ta").replace(/\/+$/, ""), n = dlgVal(el, "tn");
      if (a && !isUrl(a)) throw "地址要以 https:// 开头。";
      await saveSome({ transcribe_server: !a || a === cf.default_transcribe_server ? "" : a, speaker_name: n });
      renderSettings();
    },
  });
}

/** 高德：「Web 服务」Key（地名、附近的店、搜地点），「Web端(JS API)」Key 和安全密钥（能缩放的地图）。留空不改 */
function amapDialog() {
  const cf = S.settings, hex = /^[0-9a-f]{32}$/i;
  let mode = cf.map_mode === "official" ? "official" : "custom";
  openDialog({
    title: "高德地图", ok: "保存",
    body: `<div class="mx-field"><div class="mx-seg" role="tablist" id="am-mode">${[["official", "官方"], ["custom", "自己的 Key"]].map(([k, v]) => `<button role="tab" aria-selected="${k === mode}" class="${k === mode ? "is-on" : ""}" data-v="${k}">${v}</button>`).join("")}</div></div>
      <div id="am-official" ${mode === "official" ? "" : "hidden"}><p class="note">开通后不用填 Key</p></div>
      <div id="am-custom" class="stack" ${mode === "custom" ? "" : "hidden"}>`
      + dlgField("ak", "Web 服务 Key", { type: "password", mono: true, ph: cf.has_amap_key ? KEEP : "", help: `用于地名和附近的店 · ${howto("amap", "怎么获取")}` })
      + dlgField("jk", "地图 Key", { type: "password", mono: true, ph: cf.has_amap_js ? KEEP : "" })
      + dlgField("jc", "地图安全密钥", { type: "password", mono: true, ph: cf.has_amap_js ? KEEP : "", help: `用于显示可拖动的地图 · ${howto("amap", "怎么获取")}` }) + `</div>`,
    onOpen: (el) => {
      el.querySelector("#am-mode").onclick = (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        mode = b.dataset.v;
        el.querySelectorAll("#am-mode button").forEach((x) => { x.classList.toggle("is-on", x === b); x.setAttribute("aria-selected", x === b); });
        el.querySelector("#am-official").hidden = mode !== "official";
        el.querySelector("#am-custom").hidden = mode !== "custom";
      };
    },
    submit: async (el) => {
      if (mode === "official") { await saveSome({ map_mode: "official" }); LM.loading = null; return renderSettings(); }
      const ak = dlgVal(el, "ak"), jk = dlgVal(el, "jk"), jc = dlgVal(el, "jc");
      if (ak && !hex.test(ak)) throw "Web 服务 Key 是 32 位的字母数字。";
      if ((jk || jc) && !(hex.test(jk) && hex.test(jc))) throw "地图 Key 和安全密钥要一起填，各 32 位";
      if (!ak && !cf.has_amap_key) throw "填一个 Web 服务 Key，或者改用官方。";
      if (ak) await call("set_amap_key", { key: ak });
      if (jk) await call("set_amap_js", { key: jk, code: jc });
      await saveSome({ map_mode: "custom" }); LM.loading = null; renderSettings();
    },
  });
}

/** 同步服务器：默认官方的，自己部署了服务端（app/server）可以换。只能在登录前换 */
function syncServerDialog() {
  const cf = S.settings;
  openDialog({
    title: "同步服务器", ok: "保存",
    body: dlgField("ss", "地址", { value: cf.sync_server, mono: true, ph: cf.default_sync_server, help: `官方的是 ${esc(cf.default_sync_server)}，也可以填自己部署的` })
      + `<button class="mx-btn mx-btn--text mx-btn--sm" style="align-self:flex-start" id="ss-reset">用官方的</button>`,
    onOpen: (el) => { el.querySelector("#ss-reset").onclick = () => { el.querySelector("#ss").value = cf.default_sync_server; }; },
    submit: async (el) => {
      const v = dlgVal(el, "ss").replace(/\/+$/, "");
      if (v && !isUrl(v)) throw "地址要以 https:// 开头。";
      await saveSome({ sync_server: !v || v === cf.default_sync_server ? "" : v });
      renderSettings();
    },
  });
}

// ---------- 首次启动引导 ----------

const OB = { step: 0, err: null, msg: null, busy: false, timer: null, mode: "official" };

async function renderOnboarding() {
  document.documentElement.classList.add("onboarding");
  if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
  const st = (S.status = await call("get_status"));
  const perm = st.permissions || {};
  const steps = ["这是什么", "授权", "模型", "同步"];
  const dots = `<div class="ob-steps">${steps.map((x, i) => `<span class="${i === OB.step ? "is-on" : i < OB.step ? "done" : ""}">${i + 1}. ${x}</span>`).join("")}</div>`;
  const permRow = (kind, name, desc) => `<div class="mx-setting"><div class="mx-setting-main"><div class="mx-setting-name">${name}</div><div class="mx-setting-desc">${desc}</div></div>
    <span class="mx-status mx-status--${perm[kind] ? "ok" : "warn"}">${perm[kind] ? "已授权" : "未授权"}</span>${perm[kind] ? "" : `<button class="mx-btn mx-btn--secondary mx-btn--sm" data-perm="${kind}">去授权</button>`}</div>`;
  const msg = (OB.err ? `<div class="mx-field-error">${esc(OB.err)}</div>` : "") + (OB.msg ? `<p class="note">${esc(OB.msg)}</p>` : "");
  const body = [
    `<h1 class="ob-title">Be Authentic. Your Yesterdays.</h1>
     <p class="ob-lead">Beayy 在后台记下你在电脑和手机上的一天，写成摘要和日总结。</p>
     <div class="ob-list">
       <div><b>记什么</b><span>电脑上的应用、窗口、输入、点击和屏幕文字；手机上每个 app 的时长。密码框不记，可以排除某些 app、随时暂停或删除。</span></div>
       <div><b>存在哪</b><span>都存在这台电脑上；写摘要时，记录会发给你选的模型服务。</span></div>
     </div>`,
    IS_WIN ? `<h2>授权</h2><p class="ob-lead">Windows 上不用授权。杀毒软件拦键盘监听时，放行 Beayy。</p>`
    : `<h2>授权</h2><p class="ob-lead">macOS 要你亲自打开这三项权限。</p>
     ${permRow("accessibility", "辅助功能", "读取窗口标题和屏幕上的文字")}
     ${permRow("input_monitoring", "输入监控", "判断你在打字还是程序在操作")}
     ${permRow("full_disk_access", "完全磁盘访问（可选）", `读取 iPhone 的屏幕使用时间 · ${howto("screentime", "怎么设置")}`)}`,
    `<h2>模型</h2><p class="ob-lead">摘要和日总结要用一个大模型。用官方的：账号开通后登录就能用，不用填；也可以填自己的网关（任何兼容 OpenAI 接口的服务）。不选也能先只记录，以后在设置里改。</p>
     <div class="mx-seg" role="tablist" id="ob-mode" style="margin-bottom:var(--space-4)">${[["official", "用官方"], ["custom", "自己的网关"]].map(([k, v]) => `<button role="tab" aria-selected="${k === OB.mode}" class="${k === OB.mode ? "is-on" : ""}" data-v="${k}">${v}</button>`).join("")}</div>
     ${OB.mode === "official" ? `<p class="note">下一步登录账号，开通后就能用</p>` : `<div class="stack"><div class="mx-field"><label for="ob-gw">接口地址</label><input class="mx-input mono" id="ob-gw" value="${esc(S.draft.gateway || "https://api.openai.com/v1")}"></div>
       <div class="mx-field"><label for="ob-model">模型名</label><input class="mx-input mono" id="ob-model" value="${esc(S.draft.model_segment || "")}" placeholder="比如 gpt-4.1-mini"></div>
       <div class="mx-field"><label for="ob-key">密钥</label><input class="mx-input mono" id="ob-key" type="password" autocomplete="off" placeholder="${S.settings.has_api_key ? "已经存过一把，不改就留空" : "sk-…"}"></div>
       <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary mx-btn--sm" id="ob-test" ${OB.busy ? "disabled" : ""}>${OB.busy ? "测试中…" : "存下并测试一下"}</button></div></div>`}`,
    `<h2>同步（可选）</h2><p class="ob-lead">有好几台设备，就注册或登录一个账号；只用这一台可以跳过。</p>
     <div class="btns sync-btns"><button class="mx-btn mx-btn--secondary" id="ob-account">去登录或注册</button></div>`,
  ][OB.step];
  const last = OB.step === steps.length - 1;
  $app.innerHTML = `<div class="ob">${dots}<div class="ob-body">${body}${msg}</div>
    <div class="ob-nav">${OB.step ? `<button class="mx-btn mx-btn--text" id="ob-back">上一步</button>` : "<span></span>"}
      <button class="mx-btn mx-btn--primary" id="ob-next">${last ? "开始使用" : OB.step === 2 && OB.mode === "custom" && !S.settings.has_api_key ? "先跳过" : "继续"}</button></div></div>`;
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.onclick = f; };
  on("ob-mode", (e) => { const b = e.target.closest("[data-v]"); if (b) { OB.mode = b.dataset.v; OB.err = OB.msg = null; renderOnboarding(); } });
  $app.querySelectorAll("[data-perm]").forEach((b) => (b.onclick = () => call("open_permission", { kind: b.dataset.perm })));
  // 授权这一步：每 2 秒看一次权限，用户从系统设置回来就更新
  clearInterval(OB.timer);
  if (OB.step === 1) OB.timer = setInterval(async () => { const p = (await call("get_status")).permissions || {}; if (JSON.stringify(p) !== JSON.stringify(perm)) renderOnboarding(); }, 2000);
  const saveModel = async () => {
    const gw = document.getElementById("ob-gw").value.trim(), model = document.getElementById("ob-model").value.trim(), key = document.getElementById("ob-key").value.trim();
    S.draft = { ...S.draft, model_mode: "custom", gateway: gw, model_segment: model, model_daily: model };
    const { has_api_key, api_key_source, ...rest } = S.draft;
    await call("save_settings", { settings: rest });
    if (key) await call("set_api_key", { key });
    S.settings = await call("get_settings");
  };
  on("ob-test", async () => {
    OB.busy = true; OB.err = OB.msg = null; renderOnboarding();
    try { await saveModel(); await call("test_model"); OB.msg = "连上了，模型能用。"; } catch (x) { OB.err = `没连上：${x}`; }
    OB.busy = false; renderOnboarding();
  });
  on("ob-back", () => { OB.step--; OB.err = OB.msg = null; renderOnboarding(); });
  const finish = async (to) => {
    clearInterval(OB.timer);
    const { has_api_key, api_key_source, ...rest } = { ...S.draft, onboarded: true };
    await call("save_settings", { settings: rest });
    S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings));
    document.documentElement.classList.remove("onboarding");
    location.hash = to; route();
  };
  on("ob-account", () => finish("#/settings"));
  on("ob-next", async () => {
    if (OB.step === 2 && OB.mode === "official") { S.draft = { ...S.draft, model_mode: "official" }; await call("save_settings", { settings: { model_mode: "official" } }); }
    else if (OB.step === 2 && (document.getElementById("ob-model").value.trim() || document.getElementById("ob-key").value.trim())) { try { await saveModel(); } catch (x) { OB.err = String(x); return renderOnboarding(); } }
    if (last) return finish("#/today");
    OB.step++; OB.err = OB.msg = null; renderOnboarding();
  });
}

// ---------- 路由 ----------

async function route() {
  const [page = "today", arg, arg2] = location.hash.replace(/^#\/?/, "").split("/");
  // 换页就关掉弹层；刚拿到恢复码那个必须点「我已存好」才关
  if (DLG && DLG.closable) closeDialog();
  S.page = ["today", "summary", "rules", "devices", "settings"].includes(page) ? page : "today";
  markNav(S.page);
  try {
    if (!S.days.length && !S.status) await boot();
    if (!S.settings) { S.settings = await call("get_settings"); S.draft = JSON.parse(JSON.stringify(S.settings)); }
    if (!S.settings.onboarded && TAURI && !(S.status && S.status.mobile)) return renderOnboarding();
    if (S.page !== "devices") { DEV.id = null; stopEventsTimer(); }
    if (S.page === "summary") await renderSummary(arg, arg2);
    else if (S.page === "rules") await renderRules();
    else if (S.page === "devices") { if (arg) await renderDevice(decodeURIComponent(arg), arg2); else { DEV.id = null; stopEventsTimer(); await renderDevices(); } }
    else if (S.page === "settings") await renderSettings();
    else { TD.date = /^\d{4}-\d{2}-\d{2}$/.test(arg || "") ? arg : null; await renderToday(); }
    document.getElementById("main").scrollTop = 0;
  } catch (e) {
    $app.innerHTML = header("出错了") + `<p class="mx-error">${esc(e && e.message ? e.message : e)}</p>`;
  }
}

document.addEventListener("click", (e) => {
  for (const menu of document.querySelectorAll(".pick .mx-menu")) if (!menu.hidden && !menu.parentElement.contains(e.target)) menu.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") for (const menu of document.querySelectorAll(".pick .mx-menu")) menu.hidden = true;
});
// 后退／前进：自己记一份走过的页面，没得退或没得进时按钮置灰（照 Claude）
const NAV = { stack: [], pos: -1, jumping: false };
function trackNav() {
  const h = location.hash || "#/today";
  if (NAV.jumping) NAV.jumping = false;
  else if (NAV.stack[NAV.pos] !== h) { NAV.stack = NAV.stack.slice(0, NAV.pos + 1).concat(h); NAV.pos = NAV.stack.length - 1; }
  document.getElementById("go-back").disabled = NAV.pos <= 0;
  document.getElementById("go-fwd").disabled = NAV.pos >= NAV.stack.length - 1;
}
const jump = (d) => { const p = NAV.pos + d; if (p < 0 || p >= NAV.stack.length) return; NAV.pos = p; NAV.jumping = true; location.hash = NAV.stack[p]; };
document.getElementById("go-back").onclick = () => jump(-1);
document.getElementById("go-fwd").onclick = () => jump(1);
window.addEventListener("hashchange", trackNav);
trackNav();
document.getElementById("side-toggle").onclick = () => {
  const root = document.documentElement, collapsed = root.dataset.side === "collapsed";
  if (collapsed) delete root.dataset.side; else root.dataset.side = "collapsed";
  const btn = document.getElementById("side-toggle"), label = collapsed ? "收起侧栏" : "展开侧栏";
  btn.setAttribute("aria-label", label); btn.title = label;
  try { collapsed ? localStorage.removeItem("side") : localStorage.setItem("side", "collapsed"); } catch (e) {}
};
if (document.documentElement.dataset.side === "collapsed") { const b = document.getElementById("side-toggle"); b.setAttribute("aria-label", "展开侧栏"); b.title = "展开侧栏"; }
window.addEventListener("hashchange", route);
// 今天页每分钟自动刷新（展开着某一段、或正在看别的页时不刷）
setInterval(async () => {
  if (S.page !== "today" || isPastDay() || document.hidden || $app.querySelector("details[open]") || document.getElementById("pl-live") || EDITOR) return;
  const y = document.getElementById("main").scrollTop;
  try { [S.days, S.status] = await Promise.all([call("list_days"), call("get_status")]); renderSide(); await renderToday(); } catch (e) { return; }
  document.getElementById("main").scrollTop = y;
}, 60000);
route();
