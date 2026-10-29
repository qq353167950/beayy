package app.beayy.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import android.content.ComponentName
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * JNI、采集队列与共享 WebView 的 Android 桥。
 * WebView 的权限查询和系统设置跳转也经此桥提供。
 */
object BeayyBridge {

    init {
        System.loadLibrary("beayy_mobile")
    }

    private var activityRef: WeakReference<Activity>? = null

    fun bind(activity: Activity) { activityRef = WeakReference(activity) }
    fun unbind(activity: Activity) {
        if (activityRef?.get() === activity) activityRef = null
    }

    external fun jniCall(cmd: String, argsJson: String): String
    external fun jniStart()
    external fun setDataRoot(path: String)
    external fun setAndroidHome(path: String)
    private external fun jniCapture(op: String, argsJson: String): String

    private val worker = java.util.concurrent.Executors.newSingleThreadExecutor { r ->
        Thread(r, "beayy-capture").apply { isDaemon = true }
    }

    fun send(op: String, argsJson: String) {
        worker.execute {
            try {
                jniCapture(op, argsJson)
            } catch (t: Throwable) {
                android.util.Log.w("BeayyBridge", "capture($op) 失败", t)
            }
        }
    }

    fun send(op: String, args: org.json.JSONObject) = send(op, args.toString())

    const val JS_NAME = "AndroidBridge"

    @android.webkit.JavascriptInterface
    fun bridge(cmd: String, argsJson: String): String = try {
        jniCall(cmd, argsJson)
    } catch (t: Throwable) {
        JSONObject().put("err", t.toString()).toString()
    }

    @android.webkit.JavascriptInterface
    fun permissions(): String {
        val activity = activityRef?.get() ?: return JSONObject().put("error", "页面未就绪").toString()
        return try {
            val ctx = activity.applicationContext
            JSONObject().apply {
                put("accessibility", accessibilityEnabled(ctx))
                put("usage", UsageCollector.granted(ctx))
                put("notifications", notificationAccess(ctx))
                put("battery", ignoringBattery(ctx))
                put("auto_start", JSONObject.NULL)
            }.toString()
        } catch (t: Throwable) {
            JSONObject().put("error", t.message ?: "读取权限状态失败").toString()
        }
    }

    @android.webkit.JavascriptInterface
    fun openPermission(name: String): Boolean {
        val activity = activityRef?.get() ?: return false
        val known = name in setOf("accessibility", "usage", "notifications", "battery", "auto_start")
        if (!known) return false
        activity.runOnUiThread {
            try {
                when (name) {
                    "accessibility" -> openAccessibility(activity)
                    "usage" -> UsageCollector.openSettings(activity)
                    "notifications" -> openNotificationAccess(activity)
                    "battery" -> requestIgnoreBattery(activity)
                    "auto_start" -> openAutoStart(activity)
                }
            } catch (t: Throwable) {
                android.util.Log.w("BeayyBridge", "openPermission($name) 失败", t)
            }
        }
        return true
    }
    @android.webkit.JavascriptInterface
    fun refreshSettings(): Boolean {
        val activity = activityRef?.get() ?: return false
        activity.runOnUiThread {
            try {
                AppSettings.sync(activity)
                CaptureService.refreshSettings(activity)
                HideRecents.apply(activity, AppSettings.hideRecents)
            } catch (t: Throwable) {
                android.util.Log.w("BeayyBridge", "refreshSettings 失败", t)
            }
        }
        return true
    }

    private fun accessibilityEnabled(ctx: Context): Boolean = try {
        val manager = ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val expected = ComponentName(ctx, CaptureAccessibility::class.java).flattenToString()
        manager.getEnabledAccessibilityServiceList(android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.packageName == ctx.packageName && it.resolveInfo.serviceInfo.name == CaptureAccessibility::class.java.name }
            || Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                .orEmpty().split(':').any { it.equals(expected, ignoreCase = true) }
    } catch (_: Throwable) { CaptureAccessibility.instance != null }

    private fun notificationAccess(ctx: Context): Boolean = try {
        Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")
            .orEmpty().split(':').any { ComponentName.unflattenFromString(it)?.packageName == ctx.packageName }
    } catch (_: Throwable) { false }

    private fun ignoringBattery(ctx: Context): Boolean = try {
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName)
    } catch (_: Throwable) { false }

    private fun openAccessibility(activity: Activity) {
        val detail = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS").setData(Uri.parse("package:${activity.packageName}"))
        try { activity.startActivity(detail) } catch (_: Throwable) { activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
    }

    private fun openNotificationAccess(activity: Activity) {
        try { activity.startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")) }
        catch (_: Throwable) { activity.startActivity(Intent(Settings.ACTION_SETTINGS)) }
    }

    @SuppressLint("BatteryLife")
    private fun requestIgnoreBattery(activity: Activity) {
        if (ignoringBattery(activity)) return
        try {
            activity.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).setData(Uri.parse("package:${activity.packageName}")))
        } catch (_: Throwable) {
            activity.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun openAutoStart(activity: Activity) {
        val candidates = listOf(
            "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
            "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
            "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
            "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
        )
        for ((pkg, cls) in candidates) {
            try { activity.startActivity(Intent().setClassName(pkg, cls)); return } catch (_: Throwable) { }
        }
        activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:${activity.packageName}")))
    }
}
