package app.beayy.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * 前台 Service：让采集在后台活下来。
 *
 * ## 为什么必须有它
 *
 * Android 8.0 起后台进程会被系统冻结或杀掉。Beayy 要持续做三件事，没有它就会被中断：
 *
 * 1. **每分钟一次在场／心跳** —— 桌面上是 `presence_tick()` 每 10 秒一次；
 *    Android 这边 60 秒够了（息屏/锁屏才算离开，不需要那么密）。
 * 2. **每 5 分钟补采使用情况** —— `UsageStatsManager` 是查历史的接口，
 *    定时拉最近几分钟的前台切换，写进 `app.focus`。
 * 3. **保住进程** —— 无障碍服务是同一进程里的，进程被杀就收不到界面事件。
 *
 * ## 通知栏能不能藏
 *
 * 能藏的只有**这条通知**，不是进程本身。「设置→应用→正在运行」里永远看得到 Beayy，
 * 那是系统级的，任何应用都改不了。所以这里的「隐藏」= 通知栏不出现，通过
 * `setSilent(true)` + `IMPORTANCE_MIN` + `setShowWhen(false)` 实现，用户拉通知栏看不见。
 *
 * 但 Android 要求前台 Service 必须挂通知，一旦系统真的去检查，藏起来会被判定违规被 kill。
 * 所以默认**不藏**（诚实显示「正在记录」），用户自己选。
 *
 * ## 挂了怎么拉回来
 *
 * 三种情况分开处理：
 * - 系统因内存压力杀 → `START_STICKY` 自动重启（这里）
 * - 用户从最近任务划掉 → `onTaskRemoved` 里用 AlarmManager 定个几秒后的重启（[Revive]）
 * - 手机重启 → `BootReceiver` 收到 BOOT_COMPLETED 后拉起（[BootReceiver]）
 *
 * 「挂了自动拉起来」的开关在设置里（`keep_alive`），关掉后只保留 START_STICKY。
 */
class CaptureService : Service() {

    companion object {
        /** 心跳间隔：和桌面的 HEARTBEAT_EVERY 一致 */
        private const val TICK_SECONDS = 60L
        /** 使用情况补采间隔：5 分钟拉一次，单次覆盖最近 10 分钟（留重叠，靠去重） */
        private const val USAGE_SECONDS = 300L
        private const val USAGE_WINDOW_MIN = 10L

        const val CHANNEL_ID = "beayy.capture"
        const val CHANNEL_ID_HIDDEN = "beayy.capture.hidden"
        const val NOTIFICATION_ID = 1001
        @Volatile private var current: CaptureService? = null

        fun refreshSettings(ctx: Context) {
            current?.refreshSettings() ?: start(ctx)
        }

        fun start(ctx: Context) {
            val i = Intent(ctx, CaptureService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, CaptureService::class.java))
        }
    }

    private var pool: ScheduledExecutorService? = null
    private var hideOngoing = false
    private var keepAlive = true

    override fun onCreate() {
        super.onCreate()
        current = this
        // ★ 服务可能独立于 Activity 启动（开机自启、闹钟唤活）：
        //   这条路径上没人设过数据目录，必须在这里兜底设一次，且在 sync/jniStart 之前。
        val dataDir = getExternalFilesDir(null)?.absolutePath ?: filesDir.absolutePath
        BeayyBridge.setDataRoot(dataDir)

        AppSettings.sync(this)
        hideOngoing = AppSettings.hideOngoing
        keepAlive = AppSettings.keepAlive

        createChannels()
        // 先挂上前台通知，再开始干活：晚于 5 秒系统会抛 ANR 级异常
        startForeground(NOTIFICATION_ID, buildNotification(hideOngoing))
        BeayyBridge.jniStart()

        val p = Executors.newScheduledThreadPool(2) { r ->
            Thread(r, "beayy-service").apply { isDaemon = true }
        }
        pool = p

        // 心跳／在场
        p.scheduleWithFixedDelay({
            try {
                Presence.tick(this)
            } catch (_: Throwable) {
            }
        }, 5, TICK_SECONDS, TimeUnit.SECONDS)

        // 使用情况补采
        p.scheduleWithFixedDelay({
            try {
                UsageCollector.collectRecent(this, USAGE_WINDOW_MIN)
            } catch (_: Throwable) {
            }
        }, 15, USAGE_SECONDS, TimeUnit.SECONDS)

        // 每分钟看一次设置有没有改（用户可能在界面里刚切了「隐藏」）
        p.scheduleWithFixedDelay({
            try {
                refreshSettings()
            } catch (_: Throwable) {
            }
        }, 60, 60, TimeUnit.SECONDS)
    }

    /** 设置变了就重挂通知（隐藏/显示要重新 startForeground 才生效） */
    private fun refreshSettings() {
        AppSettings.sync(this)
        if (AppSettings.hideOngoing != hideOngoing) {
            hideOngoing = AppSettings.hideOngoing
            startForeground(NOTIFICATION_ID, buildNotification(hideOngoing))
        }
        keepAlive = AppSettings.keepAlive
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 被系统因内存压力杀掉 → 自动重启
        return START_STICKY
    }

    /**
     * 用户从「最近任务」里把 app 划掉了。
     * 这是用户显式打开「挂了自动拉起来」时的唤活路径。
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        if (keepAlive) Revive.schedule(this, 3000)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        current = null
        pool?.shutdownNow()
        pool = null
        if (keepAlive && !Revive.userStopped) Revive.schedule(this, 5000)
        super.onDestroy()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = getSystemService(NotificationManager::class.java)

        // 可见的：最低优先级，不响不震不占位
        if (mgr.getNotificationChannel(CHANNEL_ID) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "记录", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Beayy 在后台记录你在哪些 app 里做了什么"
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
            )
        }
        // 隐藏的：IMPORTANCE_NONE = 用户拉通知栏完全看不到
        // 注意：Android 只允许应用把自己的渠道降到 NONE，用户仍可在系统设置里改回来
        if (mgr.getNotificationChannel(CHANNEL_ID_HIDDEN) == null) {
            mgr.createNotificationChannel(
                NotificationChannel(CHANNEL_ID_HIDDEN, "记录（不显示）", NotificationManager.IMPORTANCE_NONE).apply {
                    description = "后台记录时不显示通知。长期使用请留意系统可能回收后台进程。"
                    setShowBadge(false)
                    setSound(null, null)
                    enableVibration(false)
                }
            )
        }
    }

    private fun buildNotification(hidden: Boolean): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val chId = if (hidden) CHANNEL_ID_HIDDEN else CHANNEL_ID
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, chId)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        b.setContentTitle("Beayy")
            .setContentText(if (hidden) "" else "正在记录")
            .setSmallIcon(android.R.drawable.ic_menu_recent_history)
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
        if (hidden) {
            // 两层保险：渠道已经 IMPORTANCE_NONE（通知栏不显示），再压一下优先级。
            // 不用 setSilent：那是 NotificationCompat 的方法，这里用的是平台 Builder。
            @Suppress("DEPRECATION")
            b.setPriority(Notification.PRIORITY_MIN)
        }
        return b.build()
    }
}

/** 读设置（走 JNI 调 Rust 的 get_settings，和界面看到的是同一份） */
object AppSettings {
    @Volatile var hideOngoing = false
    @Volatile var keepAlive = true
    @Volatile var hideRecents = false

    fun sync(ctx: Context) {
        try {
            val raw = BeayyBridge.jniCall("get_settings", "{}")
            val obj = org.json.JSONObject(raw)
            val s = obj.optJSONObject("ok") ?: obj
            hideOngoing = s.optBoolean("hide_ongoing", false)
            keepAlive = s.optBoolean("keep_alive", true)
            hideRecents = s.optBoolean("hide_recents", false)
        } catch (_: Throwable) {
            // 读不到就用默认值，别让服务因为读设置失败而起不来
        }
    }
}