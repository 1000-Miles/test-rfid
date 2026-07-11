package biz.thousandmiles.wolf

/**
 * Pistol-trigger key codes, copied from the Chainway uhf-uart-demo
 * (BaseTabFragmentActivity.onKeyDown + TestActivity). The C5P is expected to fire
 * 293; the rest cover Chainway's other handheld models. Confirm on the physical
 * unit with `adb shell getevent -l` and prune to the live code(s) once known.
 */
object TriggerKeys {
    private val CODES = setOf(
        // 188 (KEYCODE_BUTTON_1): the C5P's side trigger is remapped to this in the
        // device's KeySettings app (Right Trigger/293 → 188). The raw trigger emits an
        // Android-unmappable "F16" that the scanner service swallows, so a KeySettings
        // remap to a normal keycode is the reliable path on this MTK/UART unit.
        188,
        // Fallbacks for other Chainway models that deliver the trigger directly:
        139, 280, 291, 293, 294,
        311, 312, 313, 315,
        522, 523,
        591, 593, 594, 595, 596,
    )

    fun isTrigger(keyCode: Int): Boolean = keyCode in CODES
}
