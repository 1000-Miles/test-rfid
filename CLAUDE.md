# CLAUDE.md

Warehouse RFID stack: a Node.js **bridge** drives a Chainway UR4 UHF gate reader
and pushes movements to Nexus; a React **dashboard** is the gate screen;
**handheld/** is the C5P Android stock-audit app. See `README.md` for hardware
setup and run commands.

**Production runs on LINUX.** This Windows laptop is only the dev/test rig.
On Linux the bridge auto-selects the **Java sidecar driver** (`sidecar/UhfSidecar.java`
wrapping Chainway's `ReaderAPI` jar — spawned as a child process, no separate
unit) and runs as a **systemd service** (`scripts/install-systemd.sh`, unit
`rfid-bridge`, `Restart=always`). `UHFAPI.dll` is the Windows-only dev path.
When writing ops steps, deploy scripts, or docs, target Linux/systemd first;
see `bridge/LINUX.md` for what differs (no HW+UDP trigger mode, no USB desktop
readers — IR mode and TCP readers only).

```
bridge/      Node Express + WebSocket server, one process = one UR4 reader
dashboard/   React + Vite + TS gate UI (talks to the bridge on :3001)
handheld/    Kotlin + WebView app for the C5P handheld
docs/        architecture docs
```

## ⚠️ Two-gate deployment — keep both bridges in sync

The warehouse runs **two gates, each with its own UR4 reader**. The Chainway
SDK holds one reader connection per process (the DLL globally; the Java sidecar
a single static instance), so each gate runs its **own full copy of this repo**
(two git checkouts on the same Linux machine, e.g. `/opt/rfid-gate1` and
`/opt/rfid-gate2`), each as its own systemd service.

**Any change made to one bridge copy MUST also be applied to the other bridge
copy.** The two copies run identical code — only their `.env` and `data/`
differ. When you change `bridge/` (or `dashboard/`) code:

1. Commit the change in this repo.
2. Deploy it to **both** gate checkouts (`git pull` in each — never hand-edit
   one copy's source, that is how the gates drift apart).
3. Restart **both** gate services (`sudo systemctl restart rfid-gate1 rfid-gate2`).

Per-gate differences live ONLY in each copy's `.env`:

- `GATE_ID` — permanent unique id per physical gate (stamps every movement's
  `gateId:generation:seq` event id; required when `NEXUS_URL` is set).
- `UR4_IP` / `UR4_PORT` — that gate's reader.
- `PORT` — bridge HTTP/WS port (gate 1: 3001, gate 2: 3002; the dashboard is
  pointed at a specific bridge with `?bridge=host:port`).
- `UHF_SIDECAR_URL` — each bridge spawns its own Java sidecar on this port
  (default `http://127.0.0.1:3010`); gate 2 must use a distinct port
  (3011 is taken by the printer sidecar — use e.g. 3012).
- `NEXUS_LOCATION` — the location tag stamped on movements.
- Printer settings — only ONE gate's bridge owns the physical CP30 printer;
  the other copy runs with printing disabled.

Never share or copy `data/` between the gate checkouts: it holds that gate's
movement journal, delivery cursor, and sequence counters. A copied `data/`
makes the second gate re-deliver the first gate's movements under a new
`GATE_ID`, which double-counts in Nexus. A fresh clone starts clean — that is
the only correct way to create a gate copy.

## Working in this repo

- `bridge/`: `npm run dev` (needs the UR4 reachable, or run tests in
  `bridge/test/` which stub the reader). Movements journal to
  `bridge/data/movement-log.jsonl` before delivery — the outbox
  (`bridge/src/outbox.js`) is the only path allowed to write movements.
- `dashboard/`: `npm run dev`, opens on :5173, resolves the bridge host from
  the page URL or the `?bridge=` query param (`dashboard/src/api.ts`).
- The bridge process model is **one process = one reader**. Do not try to make
  a single process drive two readers; the DLL cannot do it.
