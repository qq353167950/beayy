package app.beayy.android

import android.content.Context
import android.os.Build
import android.os.PowerManager
import org.json.JSONObject

/**
 * 在场／心跳：屏幕状态 + 空闲时长。
 *
 * 桌面的 `presence` 是「超过 3 分钟没有键鼠算离开」。手机上等价的是「息屏或锁屏算离开」，
 * Android 的 `PowerManager.isInteractive` + `KeyguardManager.isKeyguardLocked` 就能判断。
 *
 * 这里由一个前台 Service 每分钟 tick 一次（桌面也是每 60 秒一条心跳）。
 */
object Presence {

    /** 现在是不是在用手机：亮屏且没锁屏 */
    fun isInteractive(ctx: Context): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!pm.isInteractive) return false
        val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager
        return !km.isKeyguardLocked
    }

    /**
     * 空闲多久（秒）。Android 没有桌面那种系统级 idle 计时，
     * 用 `PowerManager` 的屏幕状态近似：亮屏且解锁＝0（正在用），否则按「离开很久」算。
     * 这样 `presence` 的语义和桌面一致：active / idle 两种。
     */
    fun idleSeconds(ctx: Context): Double = if (isInteractive(ctx)) 0.0 else 300.0

    /** 打一条 presence 给 Rust（前台 Service 每分钟调一次） */
    fun tick(ctx: Context) {
        val interactive = isInteractive(ctx)
        val args = JSONObject().apply {
            put("interactive", interactive)
            put("locked", !interactive)
            put("idle_seconds", idleSeconds(ctx))
        }
        BeayyBridge.send("presence", args)
    }

    /** 设备型号，写进 app.launch 便于分辨是哪台手机 */
    fun deviceLabel(): String = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
}
