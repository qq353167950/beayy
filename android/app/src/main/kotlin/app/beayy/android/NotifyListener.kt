package app.beayy.android

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject

/**
 * 通知监听：谁发了什么。
 *
 * 只记「app + 标题」，**正文默认不记**——通知正文里常有验证码、私密消息、银行余额，
 * 落盘的代价太高。要记正文得由用户在设置里显式打开（对应 Rust 侧 `include_text`）。
 *
 * 这是 Android 独有的能力，桌面没有；摘要引擎暂时不读，但事件先存着。
 */
class NotifyListener : NotificationListenerService() {

    /** 用户可以在设置里打开；默认关 */
    @Volatile
    var includeText: Boolean = false

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val n = sbn ?: return
        // 自己的通知不记，免得递归
        if (n.packageName == packageName) return
        try {
            val ex = n.notification?.extras ?: return
            val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
            val text = ex.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
            val args = JSONObject().apply {
                put("package", n.packageName)
                put("app_name", appLabel(n.packageName))
                put("title", title)
                put("text", if (includeText) text else "")
                put("include_text", includeText)
            }
            BeayyBridge.send("notification", args)
        } catch (_: Throwable) {
            // 通知回调不能抛
        }
    }

    private fun appLabel(pkg: String): String = try {
        val pm = packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Throwable) {
        pkg
    }
}
