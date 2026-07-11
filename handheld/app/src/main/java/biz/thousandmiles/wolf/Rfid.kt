package biz.thousandmiles.wolf

import android.content.Context
import android.media.AudioManager
import android.media.ToneGenerator
import com.rscja.deviceapi.RFIDWithUHFUART
import com.rscja.deviceapi.entity.InventoryParameter
import com.rscja.deviceapi.entity.UHFTAGInfo
import com.rscja.deviceapi.interfaces.IUHF
import com.rscja.deviceapi.interfaces.IUHFInventoryCallback
import com.rscja.deviceapi.interfaces.IUHFLocationCallback
import java.util.concurrent.Executors

/**
 * Thin wrapper around Chainway's UHF SDK (`RFIDWithUHFUART`), modelled on the verified
 * uhf-uart-demo (DeviceAPI build 20251103). This plays the same role the Node
 * `bridge/src/controller.js` plays for the UR4 gate: it owns ALL reader access and
 * serialises control calls on a single-thread executor so SDK calls never overlap.
 *
 * The SDK is callback-driven (not polling like the gate): inventory + location results
 * arrive on an SDK worker thread. We forward every event as a JSON string via [emit];
 * MainActivity marshals that to the WebView on the UI thread. The JSON envelope matches
 * the dashboard's `WsMsg` types (see docs/c5p-handheld-architecture.md §4.1).
 */
class Rfid(private val context: Context, private val emit: (String) -> Unit) {

    private val io = Executors.newSingleThreadExecutor()

    @Volatile private var reader: RFIDWithUHFUART? = null
    @Volatile private var open = false
    @Volatile private var reading = false
    @Volatile private var locating = false
    @Volatile private var powerDbm = 5          // CURRENT power actually set on the module
    // Per-mode power, applied automatically when the respective operation starts:
    // inventory = low for close-range shelf work; locate = higher so the geiger can
    // acquire the tag from across the room before proximity guides you in.
    @Volatile private var inventoryPower = 5
    @Volatile private var locatePower = 20
    private var tone: ToneGenerator? = null
    private val audio by lazy { context.getSystemService(Context.AUDIO_SERVICE) as AudioManager }

    // --- lifecycle -----------------------------------------------------------

    /** Power up the UHF module. `init()` must run off the UI thread (hence the executor). */
    fun open() = io.execute {
        if (open) { emitReader(); return@execute }
        try {
            val r = RFIDWithUHFUART.getInstance()
            var ok = r.init(context)
            if (!ok) {
                // Self-heal: a previous instance killed without free() (e.g. adb install -r)
                // can leave the UHF serial port locked. free() + retry usually clears it.
                emit(Json.log("warn", "init failed — freeing port and retrying"))
                try { r.free() } catch (_: Throwable) {}
                Thread.sleep(500)
                ok = r.init(context)
            }
            if (ok) {
                reader = r
                open = true
                emit(Json.log("info", "reader init OK (version=${safeVersion(r)})"))
                // Apply the inventory power so the module doesn't run at its own (higher) default.
                applyPower(r, inventoryPower, force = true)
            } else {
                emit(Json.log("error", "reader init returned false"))
            }
        } catch (t: Throwable) {
            // Thrown on non-Chainway hardware (e.g. an emulator) or a busy port.
            emit(Json.log("error", "reader init failed: ${t.message}"))
        }
        emitReader()
    }

    fun close() = io.execute {
        stopInventoryInternal()
        stopLocationInternal()
        try { reader?.free() } catch (_: Throwable) {}
        try { tone?.release() } catch (_: Throwable) {}
        tone = null
        reader = null
        open = false
        emitReader()
    }

    /** Call from Activity.onDestroy(). */
    fun free() {
        try { close() } finally { io.shutdown() }
    }

    // --- power ---------------------------------------------------------------

    /** Set the module power if it differs from what's already applied. io-thread only. */
    private fun applyPower(r: RFIDWithUHFUART, target: Int, force: Boolean = false) {
        if (!force && powerDbm == target) return
        try {
            r.setPower(target)            // return type varies across SDK builds; don't depend on it
            powerDbm = target
            emit(Json.log("info", "power → ${target}dBm"))
        } catch (t: Throwable) {
            emit(Json.log("error", "setPower($target) failed: ${t.message}"))
        }
        emitStatus()
    }

    /** Inventory (sweep) power. Applied immediately if idle, and on every sweep start. */
    fun setInventoryPower(dbm: Int) = io.execute {
        inventoryPower = dbm
        val r = reader
        if (r != null && !locating) applyPower(r, dbm)
        else emit(Json.log("info", "inventory power = ${dbm}dBm (applies on next sweep)"))
    }

    /** Locate (hunt) power. Applied on every hunt start; restored to inventory power after. */
    fun setLocatePower(dbm: Int) = io.execute {
        locatePower = dbm
        emit(Json.log("info", "locate power = ${dbm}dBm (applies on next hunt)"))
    }

    /** Legacy single-power entry point — treated as inventory power. */
    fun setPower(dbm: Int) = setInventoryPower(dbm)

    // --- inventory -----------------------------------------------------------

    fun startInventory() = io.execute { startInventoryInternal() }
    fun stopInventory() = io.execute { stopInventoryInternal() }

    private fun startInventoryInternal() {
        val r = reader ?: run { emit(Json.log("warn", "startInventory: reader not open")); return }
        if (reading || locating) return
        applyPower(r, inventoryPower)
        r.setInventoryCallback(object : IUHFInventoryCallback {
            override fun callback(info: UHFTAGInfo) {
                // Explicit Java getters: getEPC() does NOT map to a Kotlin `.epc` property.
                emit(Json.tag(info.getEPC(), info.getRssi()?.toDoubleOrNull(), info.getTid()))
            }
        })
        val ok = r.startInventoryTag(InventoryParameter())
        reading = ok
        if (ok) beep()                     // audible feedback that a read started (trigger or button)
        emit(Json.log(if (ok) "info" else "warn", "startInventoryTag -> $ok"))
        emitStatus()
    }

    /**
     * Loud confirmation beep on read start. Handheld scanner: force the media stream to
     * full and run the tone generator at max, so it's audible on the warehouse floor
     * regardless of the device's current media-volume setting.
     */
    private fun beep() {
        try {
            val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
            audio.setStreamVolume(AudioManager.STREAM_MUSIC, max, 0)
            if (tone == null) tone = ToneGenerator(AudioManager.STREAM_MUSIC, ToneGenerator.MAX_VOLUME)
            tone?.startTone(ToneGenerator.TONE_PROP_BEEP, 200)
        } catch (t: Throwable) {
            emit(Json.log("warn", "beep failed: ${t.message}"))
        }
    }

    private fun stopInventoryInternal() {
        val r = reader ?: return
        if (!reading) return
        try { r.stopInventory() } catch (_: Throwable) {}
        try { r.setInventoryCallback(null) } catch (_: Throwable) {}
        reading = false
        emitStatus()
    }

    // --- locate / geiger -----------------------------------------------------

    fun startLocation(epc: String) = io.execute {
        val r = reader ?: run { emit(Json.log("warn", "startLocation: reader not open")); return@execute }
        if (epc.isBlank()) { emit(Json.log("warn", "startLocation: empty EPC")); return@execute }
        stopInventoryInternal()
        applyPower(r, locatePower)
        val ok = r.startLocation(context, epc, IUHF.Bank_EPC, 32, object : IUHFLocationCallback {
            override fun getLocationValue(value: Int, valid: Boolean) {
                emit(Json.locate(epc, value, valid))   // value = 0..100 proximity
            }
        })
        locating = ok
        emit(Json.log(if (ok) "info" else "warn", "startLocation($epc) -> $ok"))
        emitStatus()
    }

    fun stopLocation() = io.execute { stopLocationInternal() }

    private fun stopLocationInternal() {
        val r = reader ?: return
        if (!locating) return
        try { r.stopLocation() } catch (_: Throwable) {}
        locating = false
        applyPower(r, inventoryPower)   // drop back to sweep power after the hunt
        emitStatus()
    }

    /** Geiger sensitivity (see demo: p = 35 - sliderProgress). */
    fun setDynamicDistance(p: Int) = io.execute {
        try { reader?.setDynamicDistance(p) } catch (t: Throwable) {
            emit(Json.log("error", "setDynamicDistance failed: ${t.message}"))
        }
    }

    // --- pistol trigger (hold-to-read) ---------------------------------------

    /**
     * When the UI is on the Locate tab it registers the target EPC here; the trigger
     * then runs the geiger instead of a normal inventory. Blank/empty clears it.
     */
    @Volatile private var triggerLocateEpc: String? = null

    /**
     * UI toggle: when false, the hardware trigger no longer starts/stops anything —
     * only the on-screen buttons control the reader. Avoids the confusion of a trigger
     * release killing a read that was latched from the UI.
     */
    @Volatile private var triggerEnabled = true

    fun setTriggerEnabled(on: Boolean) {
        triggerEnabled = on
        emit(Json.log("info", "hardware trigger " + if (on) "enabled" else "disabled (UI buttons only)"))
    }

    fun setTriggerLocate(epc: String) {
        triggerLocateEpc = epc.trim().ifEmpty { null }
        emit(Json.log("info", triggerLocateEpc?.let { "trigger → locate $it" } ?: "trigger → inventory"))
    }

    fun onTriggerDown() {
        if (!triggerEnabled) return
        val epc = triggerLocateEpc
        if (epc != null) startLocation(epc) else startInventory()
    }

    fun onTriggerUp() {
        if (!triggerEnabled) return
        io.execute {
            stopInventoryInternal()
            stopLocationInternal()
        }
    }

    // --- status --------------------------------------------------------------

    fun statusJson(): String = Json.status(open, reading, locating, powerDbm)
    fun emitStatus() = emit(statusJson())
    private fun emitReader() = emit(Json.reader(open, powerDbm))

    private fun safeVersion(r: RFIDWithUHFUART): String =
        try { r.getVersion() ?: "?" } catch (_: Throwable) { "?" }
}
