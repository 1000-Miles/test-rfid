# CLAUDE.md

Warehouse RFID stack: a Node.js **bridge** drives a Chainway UR4 UHF gate reader
and pushes movements to Nexus; a React **dashboard** is the gate screen;
**handheld/** is the C5P Android stock-audit app. See `README.md` for hardware
setup and run commands.

**Production runs on LINUX.** This Windows laptop is only the dev/test rig.
On Linux the bridge auto-selects the **Java sidecar driver** (`sidecar/UhfSidecar.java`
wrapping Chainway's `ReaderAPI` jar — spawned as a child process, no separate
unit) and runs as a **systemd service** — one unit per gate, installed by running each
bridge directory's own `scripts/install-systemd.sh` (`rfid-bridge1`,
`rfid-bridge2`, `Restart=always`). `UHFAPI.dll` is the Windows-only dev path.
When writing ops steps, deploy scripts, or docs, target Linux/systemd first;
see `bridge1/LINUX.md` for what differs (no HW+UDP trigger mode, no USB desktop
readers — IR mode and TCP readers only).

```
bridge1/     Gate 1's bridge — Node Express + WebSocket, one process = one UR4 reader
bridge2/     Gate 2's bridge — DUPLICATE of bridge1's source, own .env + data/
dashboard/   React + Vite + TS gate UI (talks to a bridge on :3001 or :3002)
handheld/    Kotlin + WebView app for the C5P handheld
docs/        architecture docs
scripts/     repo-level ops (check-bridges-in-sync.sh)
```

## ⚠️ Two gates, two bridge directories — keep them IDENTICAL

The warehouse runs **two gates, each with its own UR4 reader**. The Chainway
SDK holds one reader connection per process (the DLL globally; the Java sidecar
a single static instance), so each gate needs its **own bridge process**.

Both bridges live in THIS repo — one checkout, one directory per gate:

```
bridge1/   gate 1 — port 3001, sidecar 3010, owns the physical CP30 printer
bridge2/   gate 2 — port 3002, sidecar 3012, printing disabled
```

**`bridge2/` is a byte-for-byte duplicate of `bridge1/`'s source**, and that
duplication is the standing hazard of this layout: a change made in one
directory and not the other means the two gates silently run different code,
and git will not complain. So every bridge change is four steps, in one commit:

1. Make the change in `bridge1/` (treat it as the canonical copy — docs and
   code comments point at it).
2. Mirror it to `bridge2/`:
   ```bash
   rsync -a --delete --exclude='.env' --exclude='data/' --exclude='node_modules/' bridge1/ bridge2/
   ```
3. Verify: `scripts/check-bridges-in-sync.sh` — exits 1 and prints the diff if
   the copies drifted. Run this before every commit that touches a bridge.
4. Commit both directories, then restart both services:
   ```bash
   sudo systemctl restart rfid-bridge1 rfid-bridge2
   ```

Never edit `bridge2/` directly. A change that starts there is a change that
exists in only one gate.

### What differs per gate — and ONLY these

Exactly two things are per-gate. Both are gitignored, so they never travel with
a commit, and neither is ever copied from one bridge directory to the other:
`.env` and `data/`.

- `GATE_ID` — permanent unique id per physical gate (stamps every movement's
  `gateId:generation:seq` event id; required when `NEXUS_URL` is set).
  Gate 1 `yiwu-main-gate`, gate 2 `yiwu-gate-2`.
- `GATE_SHORT` — short code inside every pallet code (`PALLET-G1-001`). MUST be
  unique per gate: two gates sharing it mint identical pallet codes and merge
  pallets in Nexus (`bridge1/src/outbox.js`). Gate 1 defaults to `G1`, gate 2
  sets `G2`.
- `UR4_IP` / `UR4_PORT` — that gate's reader.
- `PORT` — bridge HTTP/WS port (gate 1: 3001, gate 2: 3002; the dashboard is
  pointed at a specific bridge with `?bridge=host:port`).
- `UHF_SIDECAR_URL` — each bridge spawns its own Java sidecar on this port
  (gate 1 `3010`; 3011 is the printer sidecar, so gate 2 uses `3012`).
- `NEXUS_LOCATION` — the location tag stamped on movements.
- Printer settings — only ONE gate's bridge owns the physical CP30. Gate 1 has
  it; gate 2's `PRINTER_*` lines are commented out.

Never copy `data/` between the two bridge directories: it holds that gate's
movement journal, delivery cursor, and sequence counters. A copied `data/`
makes the second gate re-deliver the first gate's movements under a new
`GATE_ID`, which double-counts in Nexus. A new gate directory starts with an
empty `data/` — that is the only correct way to create one.

### Installing the services

Each bridge directory installs its own unit; the script derives the service
name from the directory and the port from that directory's `.env`, and refuses
to overwrite a unit that points at a different bridge:

```bash
sudo bridge1/scripts/install-systemd.sh    # -> rfid-bridge1 on :3001
sudo bridge2/scripts/install-systemd.sh    # -> rfid-bridge2 on :3002
```

## Working in this repo

- `bridge1/` (and `bridge2/`): `npm run dev` (needs that gate's UR4 reachable,
  or run tests in `bridge1/test/` which stub the reader). Movements journal to
  that directory's `data/movement-log.jsonl` before delivery — the outbox
  (`bridge1/src/outbox.js`) is the only path allowed to write movements.
- `dashboard/`: `npm run dev`, opens on :5173. The dashboard runs ONCE (both
  gates share it — never run a copy per gate); each gate's screen selects its
  bridge via `?bridge=<host[:port]>` (`dashboard/src/api.ts`), e.g.
  `?bridge=:3002` for gate 2 on the same machine. The phone QR (`Qr.tsx`)
  carries that target along.
- The bridge process model is **one process = one reader**. Do not try to make
  a single process drive two readers; the DLL cannot do it. That is why there
  are two bridge directories rather than one.
