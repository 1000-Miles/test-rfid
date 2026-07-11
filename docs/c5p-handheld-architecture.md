# Chainway C5P Handheld — Architecture

Companion to the UR4 gate (`bridge/` + `dashboard/`). This document specifies the
in‑facility stock‑audit handheld: its **screens**, the **Supabase schema** shared with
the gate, and the **Kotlin ↔ WebView bridge contract** that lets the existing React
dashboard run on‑device.

> Roles recap — the UR4 is the **gate** (fixed portal at entrance/exit, "what crossed
> in/out"). The C5P is the **audit tool** (roaming, "what's actually on the floor right
> now"). They are peers that meet at a shared Supabase, not one downstream of the other.

---

## 1. The shape of it

The C5P is an Android device; its UHF module is reachable **only** through Chainway's
native SDK (`com.rscja.deviceapi`, Kotlin/Java + bundled `.so`). There is no browser
path to the hardware and the pistol‑grip trigger is a native key event. So we keep the
architecture you already have — *native hardware layer + web UI* — and move it on‑device:

```
 Today (UR4, on a laptop)
   UHFAPI.dll ──► Node bridge ──WebSocket(JSON)──► React dashboard (Chrome)

 C5P (all on the phone)
   Chainway SDK ──► Kotlin bridge ──JavascriptInterface(JSON)──► React UI (WebView)
                         │
                         └── Room (SQLite) offline buffer ──► Supabase (when online)
```

The Kotlin layer plays the exact role the Node `controller.js` plays today: it owns the
SDK, runs a serialized inventory loop, handles the trigger, and emits **the same JSON
message envelope** the WebSocket emits now (`tag`, `status`, `log`, …). Because the
envelope is unchanged, the React reducer in `useBridge.ts` is reused almost verbatim —
only the *transport* is swapped (WebSocket → WebView bridge).

### How the two systems connect

```
        ┌──────────────────────────── Supabase (Postgres) ────────────────────────────┐
        │  items          gate_reads        inventory_state       count_sessions        │
        │  (registry)     (raw gate feed)   ("should be inside")   count_reads (audit)   │
        └───────────────▲──────────────────────▲──────────────────────▲─────────────────┘
                        │ writes                │ maintains             │ reads + writes
                        │                        │                       │
                  UR4 gate bridge  ──────────────┘                 C5P handheld
                  (Supabase forwarding,                            (cache expected set,
                   already wired — README §Supabase)               reconcile, upload)
```

The gate feeds reads and maintains `inventory_state` (in → `inside`, out → `outside`).
The handheld pulls the current `inside` set, sweeps the floor, and reconciles:
**present / missing / unexpected**.

---

## 2. Screens

Six screens. The first three reuse dashboard components (tag table, stat tiles, status
pills); the last three are new but small.

| # | Screen | Purpose | Reuses / new |
|---|--------|---------|--------------|
| 1 | **Home / status** | Reader power state, battery, WiFi, sync backlog count, current location selector. Big **Start audit** button. | new (small) |
| 2 | **Sweep** | Hold trigger, walk the aisle. Live unique‑EPC count, reads/sec, live table (newest first). This is the current dashboard read view. | **reuse** table + stat tiles + status pills |
| 3 | **Reconcile** | After (or during) a sweep: three lists — ✅ Present, ❌ Missing (expected but not seen), ⚠️ Unexpected (seen but not expected here). Counts + filter. | new |
| 4 | **Locate ("geiger")** | Pick one EPC (tap a Missing/Unexpected row, or scan a barcode), then a proximity meter rises as you approach it. | new (proximity meter) |
| 5 | **Sessions** | List of past audits (local + synced), status, sync state, re‑open/export. | new |
| 6 | **Settings** | Read power (dBm), session defaults, Supabase URL/key, device/operator id, EPC↔SKU display prefs. | adapts existing settings patterns |

Flow: **Home → Start audit (pick location) → Sweep → Reconcile → (Locate to chase
missing) → End session → sync.**

---

## 3. Shared Supabase schema

Extends the existing `rfid_reads` idea (README §Supabase forwarding: `epc text`,
`antenna int`, `rssi numeric`, `timestamp timestamptz`) into a two‑system model. DDL:

```sql
-- Master registry (optional but recommended). What EPCs exist and what they are.
create table if not exists items (
  epc         text primary key,
  sku         text,
  description text,
  created_at  timestamptz not null default now()
);

-- Raw gate feed (the UR4). Rename target of today's rfid_reads; keep append-only.
create table if not exists gate_reads (
  id         bigint generated always as identity primary key,
  epc        text not null,
  direction  text check (direction in ('in','out','unknown')) default 'unknown',
  antenna    int,
  rssi       numeric,
  read_at    timestamptz not null default now()
);
create index on gate_reads (epc, read_at desc);

-- Derived presence: one row per EPC = "where the system thinks it is".
-- Maintained by the gate: an 'in' read -> inside, an 'out' read -> outside.
-- This is the "should be on the floor" set the handheld reconciles against.
create table if not exists inventory_state (
  epc          text primary key references items(epc) on update cascade,
  status       text not null check (status in ('inside','outside')) default 'inside',
  last_source  text,               -- 'gate' | 'handheld'
  updated_at   timestamptz not null default now()
);
create index on inventory_state (status);

-- A handheld audit run.
create table if not exists count_sessions (
  id          uuid primary key,     -- generated on-device so offline rows are stable
  location    text,                 -- zone / aisle / room being counted
  device_id   text,
  operator    text,
  status      text not null check (status in ('open','closed','synced')) default 'open',
  started_at  timestamptz not null,
  ended_at    timestamptz,
  synced_at   timestamptz
);

-- EPCs found during a session (deduped per session, on-device).
create table if not exists count_reads (
  session_id  uuid not null references count_sessions(id) on delete cascade,
  epc         text not null,
  reads       int  not null default 1,     -- how many hits this session
  best_rssi   numeric,
  first_seen  timestamptz not null,
  last_seen   timestamptz not null,
  primary key (session_id, epc)
);
```

Reconciliation is a query, not a table — the three lists a session shows:

```sql
create or replace view session_reconciliation as
with expected as (
  select epc from inventory_state where status = 'inside'
)
select s.id as session_id, s.location,
  coalesce(cr.epc, e.epc) as epc,
  case
    when cr.epc is not null and e.epc is not null then 'present'
    when cr.epc is null      and e.epc is not null then 'missing'
    when cr.epc is not null  and e.epc is null     then 'unexpected'
  end as state
from count_sessions s
left join count_reads cr on cr.session_id = s.id
full outer join expected e on e.epc = cr.epc;
-- (Scope `expected` by location once inventory_state carries a zone column.)
```

**Sync (handheld → Supabase).** The handheld mirrors `count_sessions` / `count_reads` in
a local Room DB and `upsert`s them via PostgREST when online (`id` is a device‑generated
UUID so a row created offline keeps its identity). On session close it also pushes the
found EPCs so the gate's `inventory_state` can be corrected (a handheld‑confirmed EPC that
the gate had as `outside` is reconciled). Down‑sync: cache the latest
`inventory_state where status='inside'` snapshot locally so **Reconcile and Locate work
fully offline** against the last snapshot; refresh the snapshot whenever connectivity
returns.

> **Auth/RLS:** the anon key + open RLS is fine for the lab, as today. Before production,
> give the device a scoped key and RLS policies (insert on `count_*`, read on
> `inventory_state`/`items`). Flagged, not blocking.

---

## 4. Kotlin ↔ WebView bridge contract

Two directions. **JS → Native** = commands (methods on a `@JavascriptInterface`
object). **Native → JS** = events (JSON pushed via `evaluateJavascript`, identical
envelope to today's WebSocket messages).

### 4.1 Envelope — reuse `dashboard/src/types.ts`

The React side keeps consuming the `WsMsg` union. `tag` is **unchanged**:

```ts
// existing, reused verbatim:
interface TagMsg   { type:'tag'; epc:string; antenna:number|null; rssi:number|null; tid:string|null; timestamp:string }
interface StatusMsg{ type:'status'; /* handheld variant, see below */ timestamp:string }
interface LogMsg   { type:'log'; level:string; text:string; timestamp:string }

// new for the handheld (drop gpi/trigger — no IR beam here):
interface ReaderMsg { type:'reader'; open:boolean; powerDbm:number; battery:number|null; timestamp:string }
interface LocateMsg { type:'locate'; epc:string; proximity:number; rssi:number|null; timestamp:string } // proximity 0..100
interface KeyMsg    { type:'key'; key:'trigger'; down:boolean; timestamp:string }  // pistol trigger
interface SyncMsg   { type:'sync'; pending:number; lastSyncedAt:string|null; timestamp:string }
```

Handheld `status` replaces the gate's IR fields with reader state:

```ts
interface HandheldStatus {
  readerOpen: boolean;
  reading: boolean;
  powerDbm: number;
  battery: number | null;
  session: { id:string; location:string; found:number; expected:number } | null;
}
```

### 4.2 JS → Native (commands)

Registered with `webView.addJavascriptInterface(NativeBridge(), "Native")`. All args/returns
are strings (Android's bridge only marshals primitives); structured payloads are JSON strings.

```kotlin
class NativeBridge(private val ctx: Context, private val emit: (String) -> Unit) {
  @JavascriptInterface fun readerOpen(): String            // power up UHF module
  @JavascriptInterface fun readerClose(): String
  @JavascriptInterface fun setPower(dbm: Int): String       // 5..30
  @JavascriptInterface fun inventoryStart(): String         // continuous sweep
  @JavascriptInterface fun inventoryStop(): String
  @JavascriptInterface fun locateStart(epc: String): String // single-tag geiger
  @JavascriptInterface fun locateStop(): String
  @JavascriptInterface fun sessionStart(json: String): String // {location,operator}
  @JavascriptInterface fun sessionEnd(): String
  @JavascriptInterface fun getExpectedSet(): String         // cached inside-set JSON
  @JavascriptInterface fun syncNow(): String
  @JavascriptInterface fun getStatus(): String              // HandheldStatus JSON
}
```

Each returns a small JSON ack (`{"ok":true}` or `{"ok":false,"error":"…"}`). This mirrors
today's REST verbs (`/connect`, `/inventory/start`, `/inventory/stop`, `/mode`).

Mapping to today's `dashboard/src/api.ts`: the `api.*` fetch calls become thin wrappers
over `window.Native.*`. Provide a `nativeApi` object with the same method names so
callers don't change.

### 4.3 Native → JS (events)

Kotlin pushes each message as JSON on the **UI thread** (SDK callbacks fire on a worker
thread — marshal first):

```kotlin
fun emit(json: String) {
  webView.post { webView.evaluateJavascript("window.__onNativeMessage($json)", null) }
}
```

React registers the sink once and feeds the existing reducer:

```ts
// useHandheldBridge.ts — same reducer body as useBridge.ts, different transport
(window as any).__onNativeMessage = (msg: WsMsg) => dispatch(msg);
```

**Throttle `locate`** to ~10 Hz before emitting — the WebView handles a smooth proximity
meter fine at that rate; don't fire per raw RSSI callback.

### 4.4 Chainway SDK surface (Kotlin side)

> **SDK verified from source.** Extracted `uhf-uart-demo` (DeviceAPI build **20251103**,
> `DeviceAPI_ver20251103_release.aar`, package `com.rscja.deviceapi`). The class is
> `RFIDWithUHFUART`. Everything below is copied from the working demo
> (`BaseTabFragmentActivity`, `UHFReadTagFragment`, `UHFLocationFragment`), so it matches
> your unit — no guessing. Barcode is a separate `barcode-2d-demo` in the same bundle.

**This SDK is callback‑driven, not polling** — the opposite of the UR4 bridge, and that's
correct for Android. Tags arrive on an SDK worker thread; the demo marshals them to the UI
with a `Handler`, and we'd marshal to the WebView via `emit()` with the §4.3 throttle.
Serialize *control* calls (start/stop/power) on a single dispatcher, as the gate does.

- **Lifecycle:** `RFIDWithUHFUART.getInstance()` → `mReader.init(context)` returns `boolean`
  (run off the UI thread — the demo uses an `AsyncTask`). Diagnostics: `getVersion()`,
  `getHardwareVersion()`. Tear down with `setInventoryCallback(null)` + `free()`.
- **Inventory (continuous):** `setInventoryCallback(IUHFInventoryCallback { callback(UHFTAGInfo) })`,
  then `startInventoryTag(InventoryParameter)` → `boolean`; end with `stopInventory()`.
  Single shot: `inventorySingleTag()` → `UHFTAGInfo`.
- **Tag data:** `UHFTAGInfo` → `getEPC()`, `getTid()`, `getRssi()` (String, dBm), `getCount()`,
  `getReserved()`. No manual frame parsing (unlike the gate's `bridge/src/uhf.js` `parseTag`).
- **Locate / geiger — CONFIRMED present:**
  `startLocation(context, String epc, IUHF.Bank_EPC, 32, IUHFLocationCallback)` → `boolean`;
  callback `getLocationValue(int value, boolean valid)` where **`value` is 0–100 proximity**
  (the demo drives a chart + a proximity beep). `stopLocation()`; `setDynamicDistance(int)`
  tunes sensitivity. A richer directional `UHFRadarLocationFragment` (radar UI) also ships.
- **Power / filters:** `setPower(int)` (set in `UHFSetFragment`); filter banks
  `IUHF.Bank_EPC | Bank_TID | Bank_USER`.
- **Trigger key — CONFIRMED a KeyEvent, not a broadcast:** the host
  `Activity.onKeyDown(keyCode, event)` matches the pistol trigger, guards on
  `event.getRepeatCount() == 0`, and dispatches to the active screen (`currentFragment.myOnKeyDwon()`).
  Recognized codes include **293** (plus 139/280/291/294/311/312/313/315/591/593/594/596 —
  Chainway ships one handler covering all their models). On the C5P expect **293**; map
  down → start inventory (or `locateStart` if a target is selected) and emit `KeyMsg`.
- **Barcode (optional):** separate `barcode-2d-demo` in the same SDK bundle.

---

## 5. Project layout

Reuse the React app; add a native host and a transport adapter.

```
handheld/                    new Android Studio project (Kotlin)
  app/
    src/main/java/…/
      MainActivity.kt        hosts the WebView, wires NativeBridge
      NativeBridge.kt        @JavascriptInterface command surface (§4.2)
      Rfid.kt                Chainway SDK wrapper + serialized loop (§4.4)
      Locate.kt              geiger proximity
      TriggerKeys.kt         pistol-key handling
      sync/                  Room DAO + Supabase (PostgREST) upsert/snapshot
    src/main/assets/web/     the built React bundle (see below)

dashboard/                   EXISTING — extended, not forked
  src/
    useHandheldBridge.ts     new: WebView transport, same reducer as useBridge.ts
    nativeApi.ts             new: window.Native.* wrappers matching api.ts shape
    screens/                 Sweep (reuse), Reconcile, Locate, Sessions, Settings
```

Ship the React UI into the app one of two ways — **(a)** `vite build` → copy `dist/` into
`app/src/main/assets/web/` and load `file:///android_asset/web/index.html` (fully offline,
recommended), or **(b)** point the WebView at the dev server over WiFi during development
for hot reload. Detect environment in a small `transport.ts` so the same components run in
both the laptop dashboard (WebSocket) and the handheld (WebView).

---

## 6. Build milestones

1. **Native spike** — Android Studio project + Chainway SDK, hardcoded `inventoryStart`,
   log EPCs to Logcat. Proves the SDK binds on *your* C5P and confirms the trigger keycode.
2. **Bridge** — `NativeBridge` + `emit`; a bare WebView page that calls `Native.inventoryStart()`
   and renders `tag` messages. Proves the contract in §4 end‑to‑end.
3. **UI reuse** — build the React bundle into assets; `useHandheldBridge` + `nativeApi`;
   Sweep screen live.
4. **Locate** — geiger meter + throttled `locate` events.
5. **Supabase + offline** — Room buffer, session upload, expected‑set snapshot, Reconcile
   screen (present/missing/unexpected).
6. **Gate integration** — add `direction` + `inventory_state` maintenance to the UR4 bridge
   so the "expected inside" set is real; wire the reconciliation view.

Milestones 1–3 are the risk; everything after is additive.

---

## 7. Open decisions (confirm before/while building)

- ~~SDK version / `startLocation` / trigger keycode~~ — **RESOLVED** from the extracted
  `uhf-uart-demo` source (DeviceAPI 20251103, at `D:\Downloads\uhf-uart-demo\`): `RFIDWithUHFUART`
  confirmed, `startLocation(...)` present with a 0–100 proximity callback, trigger is a KeyEvent
  and **293** is among the handled codes (§4.4). Still worth a 30‑second `getevent` check the
  first time the physical unit is in hand — a different code in the list could be the live one.
- **Default read power** for close‑range shelf work (likely lower than the gate's, to avoid
  reading the next aisle) — set in Settings, tune on‑site.
- **Gate `direction`** — the UR4 today doesn't distinguish in vs. out (single portal). If it
  can't, `inventory_state` seeds from "ever seen at gate = inside" until an out‑antenna or a
  handheld count corrects it. Decide the seeding rule.
- **Auth/RLS** for the device key before leaving the lab (§3).
- **Barcode** — include 2D scanning for target selection, or EPC‑only? (§2 screen 4).
```
