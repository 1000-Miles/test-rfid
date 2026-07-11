# Wolf Handheld (Chainway C5P) — stock-audit app

Native Android host for the **Chainway C5P** UHF handheld. It owns the Chainway UHF SDK
and renders its UI in a WebView, mirroring the UR4 gate's *bridge + dashboard* split — see
[`../docs/c5p-handheld-architecture.md`](../docs/c5p-handheld-architecture.md).

```
 Chainway UHF SDK  ←→  Rfid.kt  ──emit(JSON)──►  WebView  (assets/web/)
 (RFIDWithUHFUART)      NativeBridge  ◄──window.Native──   the UI
```

This is the **milestone-1/2 scaffold**: it proves the SDK binds and the native↔WebView
bridge works end-to-end, using a plain HTML test harness. The React dashboard drops into
`app/src/main/assets/web/` later (same `window.__onNativeMessage` / `window.Native` contract).

## What's here

| File | Role |
|---|---|
| `Rfid.kt` | Chainway SDK wrapper — init/free, inventory (callback), locate/geiger, power. Serialised on one executor. |
| `NativeBridge.kt` | `@JavascriptInterface` command surface exposed as `window.Native`. |
| `Json.kt` | Builds the `WsMsg`-compatible event envelope pushed to the WebView. |
| `TriggerKeys.kt` | Pistol-trigger keycodes (incl. **293** for the C5P). |
| `MainActivity.kt` | Hosts the WebView, wires the bridge, handles the trigger (hold-to-read). |
| `assets/web/index.html` | Test harness: open reader, inventory, locate meter, tag table, log. |

## One-time setup

1. **Drop in the SDK.** Copy `DeviceAPI_ver20251103_release.aar` into `app/libs/`
   (from `wolf/SDK/Handhled Scanner reader/安卓手持-UHF-2D_java_SDK_20251103/uhf-uart-demo`).
   Committed to the repo like the gate's `bridge/lib/UHFAPI.dll`.
2. **Point at the Android SDK.** Create `local.properties`:
   ```
   sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk
   ```
   (Android Studio writes this for you on first open.)

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

On the device: **Open reader** → **Start inventory** (or pull the trigger) → tags stream into
the table. Enter an EPC and **Locate** to see the 0–100 proximity meter.

## Notes / TODO

- **Trigger keycode:** the handler accepts a list of Chainway codes incl. 293. Confirm the
  real one with `adb shell getevent -l` and prune `TriggerKeys.CODES`.
- **SDK transitive deps:** only the DeviceAPI `.aar` is included. If you hit a runtime
  `ClassNotFoundException`, copy the sibling jars (`xUtils-2.5.5.jar`, etc.) from the demo's
  `app/libs/` too.
- **Next milestones** (per the architecture doc): build the React dashboard into `assets/web/`;
  add Room offline buffer + Supabase sync; Reconcile screen (present/missing/unexpected).
