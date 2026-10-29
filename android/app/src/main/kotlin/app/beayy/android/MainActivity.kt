package app.beayy.android

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Android 外壳只负责启动采集并承载共享网页界面。
 * 权限状态和系统设置入口通过 [BeayyBridge] 暴露给「我的 → 设置」。
 */
class MainActivity : android.app.Activity() {

    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 必须先设数据目录，再调用任何 Rust JNI。Android 没有 HOME。
        val dataDir = getExternalFilesDir(null)?.absolutePath ?: filesDir.absolutePath
        BeayyBridge.setDataRoot(dataDir)
        BeayyBridge.setAndroidHome(dataDir)
        AppSettings.sync(this)
        HideRecents.apply(this, AppSettings.hideRecents)
        BeayyBridge.bind(this)
        BeayyBridge.jniStart()
        CaptureService.start(this)

        web = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = true
            }
            addJavascriptInterface(BeayyBridge, BeayyBridge.JS_NAME)
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(web)
    }

    override fun onResume() {
        super.onResume()
        UsageCollector.collectRecent(this, 15)
        Presence.tick(this)
        if (::web.isInitialized) web.evaluateJavascript("window.__beayyAndroidResumed && window.__beayyAndroidResumed()", null)
    }

    override fun onDestroy() {
        BeayyBridge.unbind(this)
        if (::web.isInitialized) {
            web.removeJavascriptInterface(BeayyBridge.JS_NAME)
            web.destroy()
        }
        super.onDestroy()
    }
}
