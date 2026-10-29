package app.beayy.android

import android.content.Context
import android.content.res.Configuration
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 按墨线 token 给原生控件上色：亮暗模式只走这一份颜色表，
 * 对齐 ui/vendor/moxian/tokens.css（浅色/暗色两组值）。
 *
 * 为什么不用 Theme.Material：那个主题的色板和 Beayy 的设计系统对不上，
 * 自己维护一份 12 个色的表反而更稳，且和 WebView 里的界面视觉一致。
 */
object Palette {

    /** 当前是否暗色（跟随系统） */
    fun isDark(ctx: Context): Boolean =
        (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** 12 个语义色。light/dark 两套，值取自墨线 tokens */
    data class Scheme(
        val page: Int,      // 页面底
        val surface: Int,   // 卡片底
        val ink: Int,       // 主文字
        val ink2: Int,      // 次文字
        val ink3: Int,      // 弱文字
        val line: Int,      // 分隔线
        val brand: Int,     // 品牌色（陶土色）
        val ok: Int,        // 成功
        val okInk: Int,     // 成功文字
        val okWash: Int,    // 成功浅底
        val warn: Int,      // 警示
        val warnInk: Int,   // 警示文字
        val warnWash: Int,  // 警示浅底
        val radius: Float = 12f,
    )

    fun scheme(ctx: Context): Scheme = if (isDark(ctx)) Scheme(
        page = 0xFF151515.toInt(), surface = 0xFF1A1A19.toInt(),
        ink = 0xFFF0EFEC.toInt(), ink2 = 0xFFC3C2B7.toInt(), ink3 = 0xFFA5A49A.toInt(),
        line = 0x1AFFFFFF, brand = 0xFFD67B5C.toInt(),
        ok = 0xFF6BCB77.toInt(), okInk = 0xFF6BCB77.toInt(), okWash = 0x226BCB77,
        warn = 0xFFFAB219.toInt(), warnInk = 0xFFF5C97B.toInt(), warnWash = 0x22FAB219,
    ) else Scheme(
        page = 0xFFFCFCFB.toInt(), surface = 0xFFFFFFFF.toInt(),
        ink = 0xFF0B0B0B.toInt(), ink2 = 0xFF52514E.toInt(), ink3 = 0xFF73726C.toInt(),
        line = 0x1A0B0B0B, brand = 0xFFC6613F.toInt(),
        ok = 0xFF009300.toInt(), okInk = 0xFF006300.toInt(), okWash = 0x1A009300,
        warn = 0xFFFAB219.toInt(), warnInk = 0xFF734500.toInt(), warnWash = 0x29FAB219,
    )

    // ---------- 控件工厂：颜色和形状集中在这里 ----------

    /** 圆角卡片背景 */
    fun card(ctx: Context, fill: Int, radiusDp: Float = 14f): GradientDrawable =
        GradientDrawable().apply {
            setColor(fill)
            cornerRadius = radiusDp * ctx.resources.displayMetrics.density
        }

    /** 状态点（小圆） */
    fun dot(color: Int): GradientDrawable =
        GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }
}
