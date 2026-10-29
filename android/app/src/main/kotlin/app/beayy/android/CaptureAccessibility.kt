package app.beayy.android

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * 无障碍服务：界面文字、点击、滚动、打字。语义摘要的主料就是这个。
 *
 * 这里只负责**读**（窗口树 → 字段），判断和落盘全在 Rust 的 `beayy-capture::android`，
 * 和桌面「读在平台侧、怎么记在 common」的分工一致。
 *
 * 隐私：
 * - 节点 `isPassword` 为真时，文字一律不从该节点取（Rust 侧还会再兜一层 `[REDACTED]`）
 * - 界面文字只留可见文本，过滤控件类名（`android.widget.TextView` 这种）
 * - 黑名单 app 的判断在 Rust 侧，这里照常送，由那边决定记不记
 */
class CaptureAccessibility : AccessibilityService() {

    companion object {
        /** 单次遍历上限，和桌面 common.rs 的 UI_MAX_* 对齐 */
        private const val MAX_NODES = 4000
        private const val MAX_CHARS = 12000
        private const val MAX_DEPTH = 60

        /** 当前服务实例（设置页查状态用） */
        @Volatile
        var instance: CaptureAccessibility? = null
            private set
    }

    private var lastPackage = ""
    private var lastTitle = ""

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        BeayyBridge.send("service_started", JSONObject())
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onInterrupt() {
        BeayyBridge.send("service_failed", JSONObject().put("error", "interrupted"))
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val e = event ?: return
        try {
            when (e.eventType) {
                AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> onWindowChanged(e)
                AccessibilityEvent.TYPE_VIEW_CLICKED -> onClicked(e)
                AccessibilityEvent.TYPE_VIEW_SCROLLED -> onScrolled(e)
                AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> onTextChanged(e)
            }
        } catch (t: Throwable) {
            // 无障碍事件不能抛出去：抛了系统会把服务停掉
            BeayyBridge.send("service_failed", JSONObject().put("error", t.toString()))
        }
    }

    // ---------- 窗口变化 ----------

    private fun onWindowChanged(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return
        val title = e.className?.toString().orEmpty()
        val sameApp = pkg == lastPackage
        lastPackage = pkg
        lastTitle = title

        val args = base(pkg, title)
        args.put("same_app", sameApp)
        BeayyBridge.send("foreground", args)

        // 切 app 时顺手读一次界面文字；同一 app 内换页面也读，但 Rust 侧有 30 秒节流
        val snap = snapshot(pkg, title)
        BeayyBridge.send("ui_text", snap)
    }

    // ---------- 点击 / 滚动 / 打字 ----------

    private fun onClicked(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return
        val args = base(pkg, e.className?.toString().orEmpty())
        args.put("button", "left")
        elementOf(e.source)?.let { args.put("element", it) }
        BeayyBridge.send("click", args)
    }

    private fun onScrolled(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return
        val args = base(pkg, e.className?.toString().orEmpty())
        // 系统不直接给方向，用滚动前后在屏幕上的位置粗判
        args.put("direction", if (e.scrollDeltaY > 0) "down" else "up")
        BeayyBridge.send("scroll", args)
    }

    private fun onTextChanged(e: AccessibilityEvent) {
        val pkg = e.packageName?.toString().orEmpty()
        if (pkg.isEmpty()) return
        val node = e.source ?: return
        val isPassword = try { node.isPassword } catch (_: Throwable) { false }
        // 密码框：连内容都不读，直接告诉 Rust「这里输过东西」
        val value = if (isPassword) "" else node.text?.toString().orEmpty()

        val args = base(pkg, e.className?.toString().orEmpty())
        args.put("value", value)
        args.put("is_password", isPassword)
        BeayyBridge.send("text_changed", args)
    }

    /** 回车／发送：系统不给「发送」事件，靠输入框被清空来判断（Rust 侧有同一套判据） */
    fun onEnter(pkg: String, title: String, valueAfter: String, isPassword: Boolean) {
        val args = base(pkg, title)
        args.put("value", valueAfter)
        args.put("is_password", isPassword)
        BeayyBridge.send("submit", args)
    }

    // ---------- 读窗口树 ----------

    private fun base(pkg: String, title: String): JSONObject = JSONObject().apply {
        put("package", pkg)
        put("app_name", appLabel(pkg))
        put("class_name", title)
    }

    private fun appLabel(pkg: String): String = try {
        val pm = packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Throwable) {
        pkg
    }

    /** 把当前窗口的可见文字拍平。密码节点整棵跳过。 */
    private fun snapshot(pkg: String, title: String): JSONObject {
        val root = rootInActiveWindow
        val out = StringBuilder()
        var nodes = 0
        var chars = 0
        var truncated = false
        var secure = false

        fun walk(n: AccessibilityNodeInfo?, depth: Int) {
            if (n == null || truncated) return
            if (depth > MAX_DEPTH) { truncated = true; return }
            nodes++
            if (nodes > MAX_NODES) { truncated = true; return }

            val isPwd = try { n.isPassword } catch (_: Throwable) { false }
            if (isPwd) {
                secure = true   // 有密码框：文字不取，只标一下
            } else {
                val t = n.text?.toString()?.trim().orEmpty()
                val d = n.contentDescription?.toString()?.trim().orEmpty()
                val line = t.ifEmpty { d }
                if (line.isNotEmpty() && !looksLikeControlName(line)) {
                    out.append(line).append('\n')
                    chars += line.length
                    if (chars >= MAX_CHARS) { truncated = true }
                }
            }
            if (truncated) return
            for (i in 0 until n.childCount) {
                walk(n.getChild(i), depth + 1)
                if (truncated) return
            }
        }
        walk(root, 0)

        return base(pkg, title).apply {
            put("text", out.toString().trim())
            put("nodes", nodes)
            put("truncated", truncated)
            put("secure", secure)
            put("trigger", "window_changed")
            put("url", urlOf(root))
        }
    }

    /** 控件类名不是内容：「android.widget.TextView」这种别进摘要 */
    private fun looksLikeControlName(s: String): Boolean =
        s.startsWith("android.") || s.startsWith("androidx.") || s.startsWith("com.android.internal")

    /** 浏览器／WebView 的当前网址（拿不到就是空） */
    private fun urlOf(n: AccessibilityNodeInfo?): String = try {
        val u = n?.viewIdResourceName.orEmpty()
        if (u.startsWith("http")) u else ""
    } catch (_: Throwable) {
        ""
    }

    /** 元素描述：给点击事件带上「点的是什么」 */
    private fun elementOf(n: AccessibilityNodeInfo?): JSONObject? {
        n ?: return null
        return try {
            JSONObject().apply {
                put("role", n.className?.toString().orEmpty())
                put("title", n.text?.toString()?.take(60) ?: "")
                put("description", n.contentDescription?.toString()?.take(60) ?: "")
                put("id", n.viewIdResourceName ?: "")
            }
        } catch (_: Throwable) {
            null
        }
    }
}
