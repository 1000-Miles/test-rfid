package biz.thousandmiles.wolf

import android.annotation.SuppressLint
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * Hosts the WebView UI and wires the native <-> JS bridge. This is the on-device
 * equivalent of the gate's "bridge + dashboard" split: [Rfid] is the hardware bridge,
 * the WebView is the dashboard, and [NativeBridge] + `emit` are the transport (replacing
 * the gate's WebSocket). See docs/c5p-handheld-architecture.md §4.
 *
 * Milestone 2 scaffold: loads a local test harness (assets/web/index.html). Later this
 * loads the built React bundle from the same assets/web/ folder.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var rfid: Rfid
    private lateinit var bridge: NativeBridge

    /** Set by onPageFinished; the load watchdog checks it (see armLoadWatchdog). */
    @Volatile private var pageLoaded = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        WebView.setWebContentsDebuggingEnabled(true)   // chrome://inspect from a dev PC

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            setBackgroundColor(Color.BLACK)
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                    Log.i("wolfweb", "[${msg.messageLevel()}] ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}")
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                    Log.e("wolfweb", "load error ${err.errorCode} ${err.description} for ${req.url}")
                }
                override fun onPageFinished(view: WebView, url: String) {
                    pageLoaded = true
                    Log.i("wolfweb", "page finished: $url")
                }
            }
        }
        setContentView(webView)

        // Push a native event into the web layer, on the UI thread.
        val emit: (String) -> Unit = { json ->
            webView.post {
                webView.evaluateJavascript(
                    "window.__onNativeMessage && window.__onNativeMessage($json)", null
                )
            }
        }

        rfid = Rfid(applicationContext, emit)
        bridge = NativeBridge(this, rfid, emit)
        webView.addJavascriptInterface(bridge, "Native")

        loadPageWithWatchdog()
    }

    /**
     * Load the UI and arm a watchdog: if the page hasn't finished loading in 10s the
     * device's WebView renderer has wedged (a known OS-level fault on this ROM — only a
     * device restart clears it). Surface that clearly instead of a silent white screen.
     */
    private fun loadPageWithWatchdog() {
        pageLoaded = false
        webView.loadUrl("file:///android_asset/web/index.html")
        webView.postDelayed({
            if (!pageLoaded && !isFinishing) {
                android.app.AlertDialog.Builder(this)
                    .setTitle("Display failed to start")
                    .setMessage(
                        "The screen engine on this device has stalled.\n\n" +
                        "Please RESTART the device (hold the power button → Restart), " +
                        "then open the app again."
                    )
                    .setCancelable(false)
                    .setPositiveButton("Try again") { _, _ -> loadPageWithWatchdog() }
                    .show()
            }
        }, 10_000)
    }

    // Scan trigger: hold-to-read. Intercept at dispatchKeyEvent (fires BEFORE the focused
    // view sees the key) so trigger keycodes that double as UI-confirm buttons — e.g. the
    // C5P's remapped 188/KEYCODE_BUTTON_1 — are consumed here instead of clicking a button.
    // Every key is still forwarded with its keyCode so the harness can calibrate the trigger.
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (!::bridge.isInitialized) return super.dispatchKeyEvent(event)
        val code = event.keyCode
        val trigger = TriggerKeys.isTrigger(code)
        when (event.action) {
            KeyEvent.ACTION_DOWN -> if (event.repeatCount == 0) {
                bridge.emitKey(code, true, trigger)
                if (trigger) rfid.onTriggerDown()
            }
            KeyEvent.ACTION_UP -> {
                bridge.emitKey(code, false, trigger)
                if (trigger) rfid.onTriggerUp()
            }
        }
        // Consume trigger keys so they don't also fire a click/scroll on the WebView.
        return if (trigger) true else super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        rfid.free()
        super.onDestroy()
    }
}
