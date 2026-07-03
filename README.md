# UR4 RFID Test App

A two-part desktop test rig for a **Chainway UR4** UHF RFID reader connected directly to a laptop over Ethernet.

```
dashboard/   React + Vite + TS + Tailwind UI  (browser)
bridge/       Node.js Express + WebSocket server that drives UHFAPI.dll (koffi)
```

```
 UR4 reader ──Ethernet──► bridge (loads UHFAPI.dll) ──WebSocket/REST──► dashboard
 192.168.99.202:8888        localhost:3001                              localhost:5173
```

## Prerequisites

- Windows 10/11, **Node.js 18+** (built & tested on Node 24).
- Laptop NIC set to static **192.168.99.100 / 255.255.255.0**, UR4 at **192.168.99.202**, direct Ethernet cable.
- `bridge/lib/` already contains `UHFAPI.dll` + `libusb-1.0.dll` (copied from the SDK). No compiler needed — koffi ships prebuilt binaries.

## Run it

Two terminals:

```bash
# 1) bridge
cd bridge
npm install
npm run dev            # http://localhost:3001  (WS: ws://localhost:3001/ws)

# 2) dashboard
cd dashboard
npm install
npm run dev            # http://localhost:5173
```

Open **http://localhost:5173**, enter the reader IP/port (defaults prefilled), click **Connect**, then **Start Reading**.

## Prove the DLL layer without the UI

```bash
cd bridge
npm run smoke                              # loads UHFAPI.dll, binds exports
node test/smoke.js 192.168.99.202 8888 3   # + connect & 3s inventory if reader is live
```

The smoke test dumps each tag as `epc=… ant=… rssi=…dBm raw=…`. It proves the FFI binding even with no reader attached.

## Dashboard features

- **Status pills** — bridge (WS) online + reader connected.
- **Connect form** — IP / port, Connect / Disconnect.
- **Read mode toggle**
  - **Manual** — you click Start / Stop.
  - **IR-triggered** — the reader auto-reads for a configurable burst (default 500 ms) each time the **GPI1 IR beam breaks**.
- **GPI Status** — live GPI1 / GPI2 lamps (beam clear / **BEAM BROKEN**) polled ~3×/sec, plus the raw status bytes.
- **⚡ TRIGGERED!** flash — fires on every GPI1 trigger event so you can confirm the IR sensor visually.
- **Stats** — total reads, unique EPCs, reads/sec.
- **Live table** — newest first, last 100 rows: Time | EPC | Antenna | RSSI. **Clear** resets.

## How IR triggering works (and why it's software-side)

The UR4's **hardware** trigger mode (`UHFSetWorkMode(2)`) outputs tags over **serial or UDP only — never over the TCP link** we read tags on (SDK `UHFSetWorkModePara` `param[5]` = serial/UDP). Putting the reader in that mode would divert tag data away from our poll loop.

So IR triggering is done **on the bridge**, keeping the reader in normal command mode:

1. When idle, the bridge polls `UHFGetIOStatus` (GPI inputs) every ~300 ms.
2. On a **GPI1 clear→broken edge** it emits `TRIGGERED!` and starts a timed `UHFInventory()` burst.
3. After the burst duration it calls `UHFStopGet()` and resumes GPI polling.

All tag data therefore flows through the same proven TCP + `UHF_GetReceived_EX` path as manual mode. (The reader ignores other commands mid-inventory, so the bridge never polls GPI while a burst is active.)

### ⚠️ Calibrating the GPI bit mapping

`UHFGetIOStatus`'s byte format is **not documented** in the SDK, so the GPI1/GPI2 bit mapping is a best-effort default (byte 0 → GPI1, byte 1 → GPI2, non-zero = "broken"). Verify against your hardware:

```bash
# with the reader connected, watch the raw bytes change as you break the beam:
curl http://localhost:3001/debug/io
```

If the mapping is wrong, adjust it live (no restart):

```bash
# example: GPI1 is byte 1, and "broken" means the byte reads 0
curl -X POST http://localhost:3001/debug/gpi-config \
  -H "Content-Type: application/json" \
  -d '{"gpi1Byte":1,"activeHigh":false}'
```

Config keys: `gpi1Byte`, `gpi2Byte`, `activeHigh`. Once confirmed, bake the values into `bridge/src/uhf.js` (`gpiConfig`).

## Bridge REST API

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/connect` | `{ ip, port }` | `TCPConnect`; returns `{ ok, code, ...status }` |
| POST | `/disconnect` | — | `TCPDisconnect` |
| POST | `/inventory/start` | — | manual continuous read |
| POST | `/inventory/stop` | — | stop |
| POST | `/mode` | `{ mode, irDurationMs?, irMinGapMs? }` | `mode` = `"manual"` \| `"ir"` |
| GET | `/status` | — | `{ connected, reading, mode, gpi, ... }` |
| GET | `/debug/io` | — | raw GPI/IO bytes for calibration |
| POST | `/debug/gpi-config` | `{ gpi1Byte?, gpi2Byte?, activeHigh? }` | adjust GPI mapping live |

**WebSocket** `ws://localhost:3001/ws` pushes JSON messages: `tag`, `gpi`, `trigger`, `status`, `log`.

## Optional: Supabase forwarding

Copy `bridge/.env.example` → `bridge/.env` and set:

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_TABLE=rfid_reads          # default
```

When both URL and key are set, every tag read is POSTed to the table via the Supabase REST API. Expected columns: `epc` (text), `antenna` (int), `rssi` (numeric), `timestamp` (timestamptz). Leave the vars blank to disable.

## Return codes (from the SDK)

`0` = OK · `1` = ERR_FAILURE · `2` = ERR_CONNECT_FAILURE (reader unreachable) · `3` = ERR_OPEN_PORT_FAILURE · `7` = ERR_NOT_CREATE_SOCKET.
