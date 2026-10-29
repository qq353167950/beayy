package app.beayy.android

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

/**
 * 唤活：app 被弄死了，过几秒把它拉回来。
 *
 * ## 为什么非要这套东西
 *
 * Android 上「进程没了」有好几种原因，系统给的对策各不相同：
 *
 * | 原因 | 系统的处理 | 我们还要做什么 |
 * |---|---|---|
 * | 内存不足被杀 | `START_STICKY` 会重启 | 不用管 |
 * | 用户从最近任务划掉 | **`START_STICKY` 不触发**（系统认为用户主动结束了） | `onTaskRemoved` + 闹钟 |
 * | 国产 ROM 的「省电清理」 | 直接杀，不给回调 | 只能靠闹钟周期性检查 |
 * | 手机重启 | 什么都不剩 | `BootReceiver` |
 *
 * ## 用的是什么
 *
 * `AlarmManager.setExactAndAllowWhileIdle` —— Doze 模式下也能准时触发（普通 `set` 会被拖几十分钟）。
 * 每次只定一个 3~5 秒后的单次闹钟，不设重复闹钟（重复闹钟是耗电大户，也容易被系统限流）。
 *
 * ## 诚实说明
 *
 * 这不是「绝对杀不死」。国产 ROM 的「强制停止」和用户在设置里点「强行停止」之后，
 * 系统会把应用标记为 stopped 状态，**任何闹钟和广播都不会再送达**——这是 Android 的设计，
 * 没有免 root 的绕法。所以还要配合 [MainActivity] 里的「自启动」入口引导用户去系统设置里放行。
 */
object Revive {

    private const val ACTION = "app.beayy.android.REVIVE"
    private const val REQ = 2001

    /**
     * 用户主动停了服务（点了界面里的暂停/退出）。
     * 这时候不能再拉起来，否则用户会觉得关不掉。
     */
    @Volatile
    var userStopped = false

    /**
     * 约一个 [delayMs] 之后的重启。
     *
     * 为什么用闹钟而不是 Handler：进程已经被销毁的话 Handler 跟着没了，
     * 只有系统级的闹钟能在「进程不存在」的情况下把广播打进一个新的进程。
     */
    fun schedule(ctx: Context, delayMs: Long) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = pending(ctx)
        val at = System.currentTimeMillis() + delayMs
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                // Doze 下也能准时；不需要精确到毫秒，所以不用 setAlarmClock
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, pi)
            }
        } catch (_: SecurityException) {
            // Android 12+ 对精确闹钟有额外限制；退化成不精确的（最多晚几分钟，能接受）
            try {
                am.set(AlarmManager.RTC_WAKEUP, at, pi)
            } catch (_: Throwable) {
            }
        }
    }

    fun cancel(ctx: Context) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.cancel(pending(ctx))
    }

    private fun pending(ctx: Context): PendingIntent {
        val i = Intent(ctx, ReviveReceiver::class.java).setAction(ACTION)
        return PendingIntent.getBroadcast(
            ctx, REQ, i,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** 看服务是不是还活着（活得就什么都不做） */
    internal fun serviceAlive(ctx: Context): Boolean = try {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
        @Suppress("DEPRECATION")
        am.getRunningServices(Int.MAX_VALUE).any { it.service.className == CaptureService::class.java.name }
    } catch (_: Throwable) {
        // Android 8+ 已经不给自己应用的进程列表了；查不到就当作没活、去拉一次，
        // 反正 CaptureService.start 是幂等的
        false
    }
}

/** 闹钟到点了：把前台服务拉起来 */
class ReviveReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        if (intent?.action != "app.beayy.android.REVIVE") return
        if (Revive.userStopped) return
        // 读一次设置：用户可能已经把「挂了自动拉起来」关了
        AppSettings.sync(ctx)
        if (!AppSettings.keepAlive) return
        CaptureService.start(ctx)
    }
}

/**
 * 手机重启后把采集拉起来。
 *
 * 需要 `RECEIVE_BOOT_COMPLETED` 权限；国产 ROM 通常还要在「自启动」里放行才会送到。
 *
 * 注意：`LOCKED_BOOT_COMPLETED`（直接启动，还没解锁）不能碰数据目录，所以只监听
 * 解锁后的 `BOOT_COMPLETED`。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Revive.userStopped = false
                AppSettings.sync(ctx)
                if (AppSettings.keepAlive) CaptureService.start(ctx)
            }
        }
    }
}
