# 1000Miles RFID Test Rig

Test rig for the warehouse RFID stack: a **Chainway UR4** UHF gate reader (Ethernet), a
**Chainway CP30** RFID label printer (print + EPC encode over ZPL), and a **Chainway C5P**
Android handheld for in-facility stock audits.

```
dashboard/   React + Vite + TS + Tailwind UI for the UR4 gate  (browser)
bridge/      Node.js Express + WebSocket server that drives UHFAPI.dll (koffi)
handheld/    Android app (Kotlin + WebView) for the C5P handheld reader
docs/        architecture docs (C5P handheld design, shared Supabase schema)
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
  - **IR (bridge)** — the bridge polls GPI over TCP and starts a read burst (default 500 ms) each time the **GPI1 IR beam breaks**.
  - **IR (HW+UDP)** — the reader firmware itself triggers on GPI1 (work mode 2) and pushes tag data to the bridge **over UDP**; the dashboard shows every raw datagram plus parsed tags.
- **GPI Status** — live GPI1 / GPI2 lamps (beam clear / **BEAM BROKEN**) polled ~3×/sec, plus the raw status bytes.
- **⚡ TRIGGERED!** flash — fires on every GPI1 trigger event so you can confirm the IR sensor visually.
- **Stats** — total reads, unique EPCs, reads/sec.
- **Live table** — newest first, last 100 rows: Time | EPC | Antenna | RSSI. **Clear** resets.

## Two ways to do IR triggering

The UR4's **hardware** trigger mode (`UHFSetWorkMode(2)`) outputs tags over **serial or UDP only — never over the TCP link** we read tags on (SDK `UHFSetWorkModePara` `param[5]` = serial/UDP). Both approaches are now supported:

### IR (HW+UDP) — hardware trigger mode

Select **IR (HW+UDP)** in the dashboard (`POST /mode {"mode":"hw"}`). The bridge then:

1. Sets trigger params: `UHFSetWorkModePara([GPI1, burst, minGap, UDP])`.
2. Points the reader's UDP output at this laptop: `UHFSetDestIp(<auto-detected NIC IP on the reader's subnet>, <udpPort>)` (defaults: `192.168.99.100`, port `9090`; override with `POST /mode {"destIp":"...","udpPort":9090}`).
3. Switches to trigger mode: `UHFSetWorkMode(2)`.
4. Binds a plain Node UDP socket on `udpPort` and shows **every datagram raw hex** in the dashboard's *UDP Frames* panel.

The UDP wire format is **not documented**, so the bridge scans each datagram for the known `UHF_GetReceived_EX` record layout (at offsets 0–8, tolerating a ≤4-byte trailer). Frames that parse also appear in the normal tag table (and forward to Supabase); frames that don't still show raw so the format can be calibrated. Check reader-side state anytime with `GET /debug/workmode` (work mode, trigger params, dest IP).

Note: connecting always resets the reader to command mode; if HW mode is selected it is **re-armed automatically after connect**. Manual Start/Stop is disabled in HW mode.

### IR (bridge) — software trigger, reader stays in command mode

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
| POST | `/mode` | `{ mode, irDurationMs?, irMinGapMs?, udpPort?, destIp? }` | `mode` = `"manual"` \| `"ir"` \| `"hw"` |
| GET | `/status` | — | `{ connected, reading, mode, gpi, udp, ... }` |
| GET | `/debug/io` | — | raw GPI/IO bytes for calibration |
| GET | `/debug/workmode` | — | reader work mode, trigger params, UDP dest IP |
| POST | `/debug/gpi-config` | `{ gpi1Byte?, gpi2Byte?, activeHigh? }` | adjust GPI mapping live |

**WebSocket** `ws://localhost:3001/ws` pushes JSON messages: `tag`, `gpi`, `trigger`, `status`, `log`, `udp` (raw datagram + parse result in HW mode).

## Remote reader (bridge on one PC, reader on another)

The driver layer is swappable (`UHF_DRIVER=dll | sidecar`), and the sidecar driver is the same
API over HTTP. So a USB/COM desktop reader plugged into a **different** Windows PC than the
bridge is served by running `sidecar-server.js` next to the reader:

```bash
# on the READER PC (needs this repo + Node; hosts UHFAPI.dll):
cd bridge && npm run sidecar          # listens on 0.0.0.0:3010 (SIDECAR_PORT to change)
# allow inbound 3010 in Windows Firewall on this machine

# on the BRIDGE PC:
UHF_DRIVER=sidecar UHF_SIDECAR_URL=http://<reader-pc>:3010 npm run dev
```

The bridge's REST/WS surface is unchanged — Nexus keeps pointing at the bridge. `/connect-usb`
on the sidecar reuses `reader-connect.js`'s `autoConnect` (UsbOpen, then a COM sweep), so it
inherits the phantom-link rejection; the sidecar's `/version` is gated on `isReaderAlive` so a
dead reader cannot look alive to the bridge's liveness poll. The Java sidecar
(`bridge/sidecar/`, Linux/Pi) speaks the same contract but is TCP-readers-only.

## Chainway CP30 printer — print + RFID encode

The CP30 speaks **ZPL**, so encoding a chip is just `^RFW,H^FD<hex EPC>^FS` inside a normal
`^XA…^XZ` label. The bridge builds the ZPL and sends it over one of two transports:

- **`usb`** (default) — writes RAW bytes to a Windows print queue via `winspool.drv` (koffi FFI).
  The queue uses the built-in **Generic / Text Only** driver: RAW jobs bypass the driver entirely,
  so no vendor driver is needed. One-time setup per machine (PowerShell, printer plugged in via USB):

  ```powershell
  Add-PrinterDriver -Name "Generic / Text Only"
  Add-Printer -Name "Chainway CP30" -DriverName "Generic / Text Only" -PortName "USB001"
  # find the port with: Get-PrinterPort | Where-Object Description -match 'CHAINWAY'
  ```

- **`tcp`** — raw socket to the printer's IP on **port 9100** (Ethernet/Wi-Fi). No setup at all;
  read the printer's IP off its touchscreen and switch the transport in the dashboard.

Test EPCs are sequential 96-bit values `<prefix><zero-padded hex counter>` (default prefix `AA00`),
persisted in `bridge/data/printer.json` so they stay unique across restarts.

### Dashboard flow

The **Print & Encode** panel: pick transport (USB queue dropdown / IP:9100), optionally type an
explicit hex EPC (blank = next auto test EPC), hit **Print & Encode**, then **Read 5s to verify** —
hold the printed label near the UR4; the panel turns green (**✓ VERIFIED**) when the reader reports
the freshly printed EPC. A collapsible **raw ZPL console** is there for tuning experiments.

### CLI (no UI needed)

```bash
cd bridge
npm run print                                   # next auto test EPC -> USB queue "Chainway CP30"
node test/print-test.js AA0000000000000000000123  # explicit EPC (24 hex chars)
node test/print-test.js --tcp 192.168.99.201:9100 # network transport instead
node test/print-test.js --zpl-only                # show generated ZPL, send nothing
node test/print-test.js --raw label.zpl           # send a ZPL file verbatim
```

### Printer REST API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/printer/status` | — | config + next auto EPC + last print |
| POST | `/printer/config` | any of `{ transport, printerName, host, port, epcPrefix, barcode, widthDots, heightDots, extraZpl }` | persisted |
| POST | `/printer/print` | `{ epc?, title?, copies? }` | omit `epc` for next auto test EPC |
| GET | `/printer/preview` | `?epc=&title=` | generated ZPL without printing |
| POST | `/printer/raw` | `{ zpl }` | send arbitrary ZPL verbatim |
| GET | `/printer/queues` | — | Windows print queue names |

### If encoding fails on the large tags

The label prints but the chip doesn't verify (or the printer voids it): tune **offset** and
**write power** in the printer's on-screen **RFID Setup** — find the inlay by holding a label up to
the light, set the offset so the chip sits over the printer's antenna, then raise write power.
`^RS`-based tuning can also be sent from the raw ZPL console (`extraZpl` config slots it into every label).

## Desktop reader — identify + encode tags

A desktop USB reader (Chainway R3 / R1) encodes tags at a bench rather than on
the line. Three CLI tools, run in order. All of them auto-detect the transport:
`UsbOpen()` first, then every registered COM port.

```bash
cd bridge
node test/probe-reader.js      # 1. is a reader there, and what is it set to
node test/tag-info.js          # 2. what chip is this tag, how big, is it locked
node test/encode-tags.js       # 3. dry run — show what would be written
node test/encode-tags.js --commit --count 10
```

Two more when something misbehaves:

```bash
node test/diagnose-write.js    # a write failed — which of the 5 causes is it
node test/calibrate-signal.js  # where do writes actually stop working
```

`calibrate-signal.js` steps reader power down with the tag left in place, so the
only variable is signal, and records RSSI against single-attempt (un-retried)
write success. It exists because Tag Station's signal bands were first set from
general RFID lore and were wrong for this rig — they called -62 dBm "weak" when
a tag flat on metal reads exactly there, while writes verified 5/5 at -65.3 dBm.
Run it and feed the suggested bands back into `signalBand()` in
`tag-station-client.tsx`.

### ⚠️ `UsbOpen()` returns 0 with nothing plugged in

Verified 2026-08-06 on this DLL. It is not a "maybe" — several getters then
return rc=0 while leaving their output buffer unwritten (`UHFGetPower` reported
123 dBm, then 43 dBm, then 0 dBm on consecutive runs of an empty link), the
version strings come back as constants baked into the DLL
(`V1.0.7,R1_Nu,2025-06-27`), and **`UHFInventorySingle` segfaults the process**.

So an SDK return code of 0 must never be treated as "connected". `uhf.isReaderAlive()`
is the gate: `UHFGetRegion` + `UHFGetProtocolType` were the only calls that
consistently failed on the phantom link. Every CLI tool and `controller.connectUsb()`
go through it.

### ⚠️ A desktop reader has no GPIO — don't health-check it with GPI

The controller polls GPI every 150 ms while idle and treats 3 consecutive
failures as a lost link. That is correct for the **UR4 gate**, where GPI1/GPI2
are the IR beams. A **desktop reader (R3/R1) has no GPIO at all**, so every poll
fails and the bridge declared a perfectly healthy reader dead ~450 ms after
connecting — then `_reconnectLoop` closed the USB handle and only ever retried
over TCP, so the link never came back.

The visible symptom was a *write* that failed with a non-zero rc: the request
guard saw `connected: true`, the reconnect loop closed the handle underneath it,
and the write ran against a dead handle. It looked exactly like a locked tag.

`controller._detectGpio()` now probes GPIO capability once per link and reports
it as `hasGpio` on `/status`. When false: GPI polling is off, liveness uses
`isReaderAlive()` every 5 s instead, IR/HW modes are refused with a clear error,
and reconnect re-opens over **the transport that was actually in use**.

### Encoding safety

Three independent layers, because a mis-write only surfaces later, in the
warehouse, as a pallet that resolves to the wrong thing:

1. **One tag in the field.** `requireSingleTag` refuses to act if a second answers.
2. **Every write is addressed by TID.** The TID is factory-unique and immutable,
   so a tag that wanders into range mid-write cannot be the chip programmed.
   This — not low power — is what makes "wrote to a neighbour in the bag" impossible.
3. **Low power** on top (default 10 dBm, `--power N`).

Verification uses two oracles that fail independently: a TID-filtered read-back
of the EPC bank, **and** a fresh over-the-air singulation that must now report
the new EPC. Both must agree. Every attempt lands in `data/pallet-encode-log.jsonl`.

Prove the verifier actually bites before trusting a green run:

```bash
node test/encode-tags.js --commit --prove-fail   # must report PROVE-FAIL PASSED
```

It writes the real EPC but verifies against a deliberately wrong one, so a run
that still reports "verified" means the check is broken.

### EPC namespaces

An EPC is raw hex, so a prefix can only use `0-9 A-F` — "PL" for pallet is not
encodable. The first two chars are an opaque **tag-kind code**:

| Prefix | Meaning | Minted by |
|---|---|---|
| `BC01…` | carton | Nexus `operations_next_epcs` |
| `BA01…` | pallet | Nexus `operations_next_pallet_epcs` (`--nexus`) |
| `BA0F…` | bench | locally, `data/pallet-epc.json` |

All are 24 hex chars / 96-bit. The bench prefix differs on purpose: bench tags
can never collide with the real `BA01` space, and a stray one is obvious in a scan.

### Regional note

Chinese-supplied readers ship on the China band (920–925 MHz). The Philippines
allocates **918–920 MHz** for UHF RFID with a 500 mW ERP cap, and NTC requires
readers to be type-approved and registered. `probe-reader.js` reports the current
region and `--set-region 8` selects the USA preset (902–928 MHz), the closest one
that covers the Philippine allocation. Not blocking for desk encoding; settle it
before any fixed reader is deployed.

Anti-metal tags often read *better* against metal than in free air — if one won't
read, lay it flat on a metal surface.

### Bridge tag-access API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/tag` | — | singulate one tag: PC, EPC, EPC word count, TID |
| POST | `/tag/read` | `{ bank, ptr, words, tid?\|epc?, accessPwd? }` | bank 0=RESERVED 1=EPC 2=TID 3=USER; ptr/words in **words** |
| POST | `/tag/write` | `{ bank, ptr, data, tid?\|epc?, accessPwd? }` | always reads back; returns `verified` |

Prefer `tid` over `epc` for addressing: an EPC filter matches whatever currently
carries that EPC, a TID filter matches one physical chip.

## Chainway C5P handheld — in-facility stock audit

The UR4 gate watches what enters/leaves; the **C5P handheld** roams the floor to audit
what's actually there. It's a native Android app (Kotlin bridge over Chainway's UHF SDK +
an offline WebView UI) with inventory sweep, a locate/geiger tag finder, hold-to-read
trigger support, and dual sweep/hunt power. Build, per-device setup (trigger remap,
WebView pin), and troubleshooting: **[handheld/README.md](handheld/README.md)**. Design +
the shared Supabase schema both systems will meet at:
**[docs/c5p-handheld-architecture.md](docs/c5p-handheld-architecture.md)**.

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
