package app.beayy.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import org.json.JSONObject

/**
 * 系统事件：电量、网络、屏幕、解锁、耳机、装卸、省电模式。
 *
 * 这些是 Android 独有、桌面没有的信号，但对「解释当时在干什么」很有用：
 * - 断网 → 同步失败／接口调不通的线索
 * - 插耳机 → 在听东西或开会
 * - 省电模式 → 后台被限制、采集会断档（否则用户会以为 Beayy 坏了）
 */
class SystemEvents : BroadcastReceiver() {

    /** 上次的电量，避免每 1% 都写一条 */
    private var lastBattery = -1
    private var lastCharging: Boolean? = null

    override fun onReceive(ctx: Context, intent: Intent) {
        try {
            when (intent.action) {
                Intent.ACTION_BATTERY_CHANGED -> onBattery(intent)
                Intent.ACTION_SCREEN_ON -> BeayyBridge.send("screen_on", JSONObject())
                Intent.ACTION_SCREEN_OFF -> BeayyBridge.send("screen_off", JSONObject())
                Intent.ACTION_USER_PRESENT -> BeayyBridge.send("unlock", JSONObject())
                Intent.ACTION_HEADSET_PLUG ->
                    BeayyBridge.send("headset", JSONObject().put("plugged", intent.getIntExtra("state", 0) == 1))
                Intent.ACTION_PACKAGE_ADDED ->
                    intent.data?.schemeSpecificPart?.let {
                        BeayyBridge.send("install", JSONObject().put("package", it))
                    }
                Intent.ACTION_PACKAGE_REMOVED ->
                    intent.data?.schemeSpecificPart?.let {
                        BeayyBridge.send("uninstall", JSONObject().put("package", it))
                    }
                ConnectivityManager.CONNECTIVITY_ACTION -> onNetwork(ctx)
                android.os.PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED -> onDoze(ctx)
            }
        } catch (_: Throwable) {
            // 广播接收器不能抛
        }
    }

    private fun onBattery(intent: Intent) {
        val percent = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val plugged = when (intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, -1)) {
            BatteryManager.BATTERY_PLUGGED_AC -> "ac"
            BatteryManager.BATTERY_PLUGGED_USB -> "usb"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            else -> ""
        }
        // 只在充放电状态变了、或电量跨过 10% 时记一条
        val bucket = percent / 10
        if (charging == lastCharging && bucket == lastBattery / 10) return
        lastCharging = charging
        lastBattery = percent
        BeayyBridge.send(
            "battery",
            JSONObject().put("percent", percent).put("charging", charging).put("plugged", plugged)
        )
    }

    private fun onNetwork(ctx: Context) {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        val kind = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        val metered = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) != true
        BeayyBridge.send(
            "network",
            JSONObject().put("type", kind).put("online", online).put("metered", metered)
        )
    }

    private fun onDoze(ctx: Context) {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        BeayyBridge.send("doze", JSONObject().put("idle", pm.isDeviceIdleMode))
    }
}
