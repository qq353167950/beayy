package app.beayy.android

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process
import org.json.JSONObject

/**
 * 屏幕使用时间：每个 app 什么时候在前台。
 *
 * Android 的 `UsageStatsManager` 直接给到「前台区间」——比 iOS 那套「经 iCloud 同步到 Mac 再解析
 * Biome 文件」干净得多。写出来的事件和 iPhone 的 `app.focus` 同一套字段，
 * 所以 `data.rs` 里的手机统计不用区分平台。
 *
 * 需要用户在「设置 → 使用情况访问权限」里手动授予（`PACKAGE_USAGE_STATS` 是特殊权限，
 * 不能靠运行时申请，只能跳设置页）。
 */
object UsageCollector {

    /** 有没有拿到使用情况访问权限 */
    fun granted(ctx: Context): Boolean = try {
        val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = appOps.unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            ctx.packageName
        )
        mode == AppOpsManager.MODE_ALLOWED
    } catch (_: Throwable) {
        false
    }

    /** 跳到系统的「使用情况访问权限」页 */
    fun openSettings(ctx: Context) {
        try {
            ctx.startActivity(
                android.content.Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (_: Throwable) {
        }
    }

    /**
     * 把 [fromMs, toMs) 之间的前台切换补成 `app.focus` 事件。
     *
     * 为什么补而不是实时记：`UsageStatsManager` 本身是「查历史」的接口，查询代价低，
     * 而且能覆盖应用被杀掉的那段时间——比常驻监听更省电、更完整。
     *
     * 去重：Rust 侧按（时间、开始/结束、包名）判重，重复调用不会写重复数据。
     */
    fun collect(ctx: Context, fromMs: Long, toMs: Long): Int {
        if (!granted(ctx)) return 0
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val events = usm.queryEvents(fromMs, toMs)
        val e = UsageEvents.Event()
        var n = 0
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            val type = e.eventType
            // 只关心「进入前台」和「退到后台」两种
            if (type != UsageEvents.Event.ACTIVITY_RESUMED && type != UsageEvents.Event.ACTIVITY_PAUSED) continue
            val pkg = e.packageName ?: continue
            val appName = appLabel(ctx, pkg)
            if (pkg == ctx.packageName) continue
            val t = e.timeStamp
            val start = type == UsageEvents.Event.ACTIVITY_RESUMED
            val args = JSONObject().apply {
                put("package", pkg)
                put("app_name", appName)
                put("state", if (start) "start" else "end")
                // 和 iPhone 的 biome_time 对齐：秒为单位的浮点
                put("biome_time", t / 1000.0)
                put("source", "android:UsageStatsManager")
            }
            BeayyBridge.send("focus", args)
            n++
        }
        return n
    }
    private fun appLabel(ctx: Context, pkg: String): String = try {
        ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo(pkg, 0)).toString().ifBlank { pkg }
    } catch (_: Throwable) {
        pkg
    }

    /** 最近 [minutes] 分钟的增量（前台 Service 每次 tick 调一次） */
    fun collectRecent(ctx: Context, minutes: Long): Int {
        val now = System.currentTimeMillis()
        return collect(ctx, now - minutes * 60_000, now)
    }
}
