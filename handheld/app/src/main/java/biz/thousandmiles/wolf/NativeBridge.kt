package biz.thousandmiles.wolf

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * JS -> native command surface (docs/c5p-handheld-architecture.md §4.2). Exposed to
 * the WebView as `window.Native`. Each method kicks work onto [Rfid] (which serialises
 * on its own executor) and returns a small JSON ack immediately; results/tags flow back
 * asynchronously as events via `emit` -> `window.__onNativeMessage`.
 *
 * Only methods annotated with @JavascriptInterface are reachable from JS.
 */
class NativeBridge(
    private val activity: MainActivity,
    private val rfid: Rfid,
    private val emit: (String) -> Unit,
) {
    @JavascriptInterface fun readerOpen(): String { rfid.open(); return OK }
    @JavascriptInterface fun readerClose(): String { rfid.close(); return OK }
    @JavascriptInterface fun setPower(dbm: Int): String { rfid.setPower(dbm); return OK }
    @JavascriptInterface fun setInventoryPower(dbm: Int): String { rfid.setInventoryPower(dbm); return OK }
    @JavascriptInterface fun setLocatePower(dbm: Int): String { rfid.setLocatePower(dbm); return OK }
    @JavascriptInterface fun inventoryStart(): String { rfid.startInventory(); return OK }
    @JavascriptInterface fun inventoryStop(): String { rfid.stopInventory(); return OK }
    @JavascriptInterface fun locateStart(epc: String): String { rfid.startLocation(epc); return OK }
    @JavascriptInterface fun locateStop(): String { rfid.stopLocation(); return OK }
    /** Locate tab registers its target here; trigger then runs geiger instead of inventory. */
    @JavascriptInterface fun setTriggerLocate(epc: String): String { rfid.setTriggerLocate(epc); return OK }
    /** UI toggle: false = hardware trigger ignored, only on-screen buttons control the reader. */
    @JavascriptInterface fun setTriggerEnabled(on: Boolean): String { rfid.setTriggerEnabled(on); return OK }
    @JavascriptInterface fun setDynamicDistance(p: Int): String { rfid.setDynamicDistance(p); return OK }
    @JavascriptInterface fun getStatus(): String = rfid.statusJson()

    /** Called by MainActivity for every hardware key, so the UI can display keycodes. */
    fun emitKey(code: Int, down: Boolean, trigger: Boolean) = emit(Json.key(code, down, trigger))

    private companion object {
        const val OK = "{\"ok\":true}"
    }
}
