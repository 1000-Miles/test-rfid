# 1000Miles Handheld (Chainway C5P) — stock-audit app

Native Android app for the **Chainway C5P** UHF handheld. Companion to the UR4 gate
(`../bridge` + `../dashboard`): the gate watches what enters/leaves, the handheld roams
the floor to audit what's actually there. Full design:
[`../docs/c5p-handheld-architecture.md`](../docs/c5p-handheld-architecture.md).

```
 Chainway UHF SDK  ←→  Rfid.kt  ──emit(JSON)──►  WebView  (assets/web/)
 (RFIDWithUHFUART)      NativeBridge  ◄──window.Native──   the UI
```

The native layer owns the reader (same role the Node bridge plays for the UR4); the UI
is an offline web bundle. The current UI is a full-featured test harness; the production
React dashboard will drop into `assets/web/` using the same bridge contract.

## Features (verified on-device)

- **Inventory sweep** — continuous read of every tag in range; live list with counts,
  RSSI, timestamps; tap a tag to hunt it.
- **Locate / geiger** — pick a target (dropdown of seen tags, or manual EPC) and the
  0–100 proximity meter guides you to it.
- **Gun trigger / Manual modes** (exclusive, persisted) — hold-to-read on the physical
  trigger, or on-screen toggles; never both, so a trigger release can't cancel a
  UI-started read. Trigger is context-aware: sweeps in Inventory, hunts in Locate.
- **Dual power, native-enforced** — sweep power (default 5 dBm, close-range precise) and
  hunt power (default 20 dBm, longer acquisition) switch automatically; max 30 dBm.
- **Status strip** — Reader / Activity / Trigger / Power chips with live state colors.
- **Tap-for-help** — ⓘ icons on every non-obvious control open plain-language explanations.
- Loud beep on read start, load watchdog (see Troubleshooting), Montserrat + Lucide
  icons, fully offline.

## Project map

| File | Role |
|---|---|
| `Rfid.kt` | Chainway SDK wrapper — open/close, sweep, locate, dual power, beep, trigger actions. Single-threaded executor serializes all SDK access. |
| `NativeBridge.kt` | `@JavascriptInterface` command surface exposed as `window.Native`. |
| `Json.kt` | Event envelope (tag/locate/status/key/log) pushed to `window.__onNativeMessage`. |
| `TriggerKeys.kt` | Accepted trigger keycodes (incl. **188** — see device setup below). |
| `MainActivity.kt` | WebView host, `dispatchKeyEvent` trigger interception, load watchdog. |
| `assets/web/index.html` | The UI (self-contained; Montserrat + inline Lucide SVGs). |
| `assets/web/fonts/` | Bundled Montserrat variable font. |

## One-time setup — per development machine

1. Android Studio (bundles the JDK) + Android SDK platform 34. `local.properties` points
   at the SDK (Android Studio writes it on first open).
2. The Chainway SDK (`app/libs/DeviceAPI_ver20251103_release.aar`) is committed — no
   download needed.

## One-time setup — per C5P device

1. **Trigger remap** (the side scan key is otherwise swallowed by the vendor scanner
   service): open the preinstalled **KeySettings** app → menu → *New mapping* → press the
   side trigger (captures "Right Trigger", 293) → mode *Remap* → *CUSTOM KEYCODE* → enter
   **188** → confirm → save (✓). The app listens for 188.
2. **Pin the WebView** (Play-updated WebViews wedge this ROM's renderer — white-screen
   hangs). With USB debugging on:
   ```
   adb shell pm uninstall-system-updates com.google.android.webview
   adb shell pm disable-user --user 0 com.android.vending
   ```
   This reverts to the factory WebView (94) and stops Play from re-updating it.
   (Consequence: keep the web UI Chrome-94 compatible. Re-enable Play anytime with
   `adb shell pm enable com.android.vending`.)

## Build & run

- **Android Studio:** open this `handheld/` folder, let Gradle sync, Run on the C5P (USB debugging on).
- **CLI:** `./gradlew :app:assembleDebug` → `app/build/outputs/apk/debug/`, then
  `adb install -r app/build/outputs/apk/debug/app-debug.apk`.

### Optimized release build

`./gradlew :app:assembleRelease` → `app/build/outputs/apk/release/app-release.apk`
(R8-minified + resource-shrunk, ~30% smaller; the Chainway SDK and the JS bridge are
protected by `proguard-rules.pro`).

Signing reads `keystore.properties` + `wolf-release.jks` in this folder — both are
**gitignored, never commit them**. Without them, release builds fall back to the debug
key (still installable, fine for testing). To regenerate a key:

```
keytool -genkeypair -keystore wolf-release.jks -alias wolf -keyalg RSA -keysize 2048 -validity 10950
```

then write `keystore.properties` with `storeFile` / `storePassword` / `keyAlias` /
`keyPassword`. Keep a backup of the keystore — updating an installed app requires the
same key. Note: debug and release APKs have different signatures, so switching between
them on a device requires uninstalling first.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| "Display failed to start" dialog (or white screen) | WebView renderer wedged (OS-level). **Restart the device.** Rare after the WebView pin. |
| Reader toggle won't open, log shows `reader init returned false` | UHF serial port left locked by an unclean app kill. The app auto-retries once; if it still fails, **restart the device.** |
| Trigger does nothing (no `key 188` in the event log) | The KeySettings remap is missing on this unit — redo device setup step 1. |
| Tags read from too far / not far enough | Adjust sweep power (Inventory tab). Hunts use their own power (Locate tab). |

## Next phase

Port the real React dashboard into `assets/web/` (same `window.Native` /
`__onNativeMessage` contract), then add Supabase sync + the present/missing/unexpected
reconcile screen — see the architecture doc §3–5.
