package biz.thousandmiles.wolf

import org.json.JSONObject

/**
 * Builds the JSON event envelope the WebView consumes. Field names mirror the
 * dashboard's `WsMsg` union + the handheld additions in
 * docs/c5p-handheld-architecture.md §4.1, so the React reducer can be reused.
 */
object Json {

    fun tag(epc: String?, rssi: Double?, tid: String?): String =
        obj {
            put("type", "tag")
            put("epc", epc ?: JSONObject.NULL)
            put("antenna", 1)                       // handheld: single antenna
            put("rssi", rssi ?: JSONObject.NULL)
            put("tid", tid ?: JSONObject.NULL)
            put("ts", now())
        }

    /** proximity is 0..100 (SDK getLocationValue). */
    fun locate(epc: String, proximity: Int, valid: Boolean): String =
        obj {
            put("type", "locate")
            put("epc", epc)
            put("proximity", proximity)
            put("valid", valid)
            put("ts", now())
        }

    /** Every hardware key is reported with its Android keyCode; `trigger` marks recognized scan keys. */
    fun key(code: Int, down: Boolean, trigger: Boolean): String =
        obj {
            put("type", "key")
            put("code", code)
            put("down", down)
            put("trigger", trigger)
            put("ts", now())
        }

    fun reader(open: Boolean, powerDbm: Int): String =
        obj {
            put("type", "reader")
            put("open", open)
            put("powerDbm", powerDbm)
            put("ts", now())
        }

    fun status(readerOpen: Boolean, reading: Boolean, locating: Boolean, powerDbm: Int): String =
        obj {
            put("type", "status")
            put("readerOpen", readerOpen)
            put("reading", reading)
            put("locating", locating)
            put("powerDbm", powerDbm)
            put("ts", now())
        }

    fun log(level: String, text: String): String =
        obj {
            put("type", "log")
            put("level", level)
            put("text", text)
            put("ts", now())
        }

    private inline fun obj(build: JSONObject.() -> Unit): String =
        JSONObject().apply(build).toString()

    private fun now(): Long = System.currentTimeMillis()
}
