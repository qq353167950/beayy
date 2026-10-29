package app.beayy.android

import android.app.ActivityManager
import android.content.Context
import android.os.Build

/**
 * 隐藏最近任务：让 Beayy 不出现在「最近任务」列表（多任务切换界面）里。
 *
 * ## 这藏的是什么、藏不了什么
 *
 * 用 `ActivityManager.AppTask.setExcludeFromRecents(true)`，作用对象是**任务栈**：
 *
 * - ✅ 从「最近任务」里消失 —— 别人拿到你手机翻多任务，看不到 Beayy 开着
 * - ✅ 顺带降低被误杀的概率 —— 用户不会在清理多任务时把它划掉
 * - ❌ 进程本身藏不了 —— 「设置 → 应用 → 正在运行」里永远能看到，这是系统的界面，任何应用无权干预
 * - ❌ 桌面图标也藏不了（那是另一个能力，且要用户主动隐藏）
 *
 * 结论：这是 Android 平台允许做到的最大程度。要真「藏进程」只能 root / Xposed，
 * 那不在这个应用的边界里。
 *
 * ## 什么时候调用
 *
 * `setExcludeFromRecents` 只作用于**当前任务栈**，所以必须在开关切换的那一刻、
 * 在 Activity 还活着的时候调一次；等下次进后台再调就晚了（那时任务栈已经不受控）。
 * 参考实现见 [applyToggle]，由 [MainActivity] 在设置变化后立刻调用。
 */
object HideRecents {

    /** 有没有开着「隐藏最近任务」（直接读设置，比查任务栈可靠——excludeFromRecents 要 API 29 才能查） */
    fun enabled(ctx: Context): Boolean {
        AppSettings.sync(ctx)
        return AppSettings.hideRecents
    }


    /**
     * 立刻应用设置。必须在 Activity 上下文里调（要拿 appTasks）。
     *
     * 返回是否成功——失败通常是因为拿不到任务栈（比如从 Service 里调），
     * 这时不要报错，让下次进 Activity 时再试。
     */
    fun apply(ctx: Context, enable: Boolean): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
        return try {
            val tasks = am.appTasks
            tasks.forEach { it.setExcludeFromRecents(enable) }
            true
        } catch (_: Throwable) {
            false
        }
    }
}
