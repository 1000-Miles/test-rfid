# Running the bridge on Linux (Raspberry Pi / any distro)

The bridge is fully cross-platform. On Linux it uses the **sidecar driver**:
a tiny Java HTTP shim (`sidecar/UhfSidecar.java`) wrapping Chainway's pure-Java
SDK (`ReaderAPI20240822.jar`), which talks to the UR4 over TCP. The Node bridge
spawns the sidecar automatically — no manual start needed.

`driver.js` selects it automatically on any non-Windows platform (no env var
needed). `UHF_DRIVER=sidecar` forces it on Windows too, for testing.

## What works on Linux

| Feature | Status |
|---|---|
| TCP connect to UR4 / UR1A gate readers | ✅ |
| Manual inventory + live tag stream (WS) | ✅ |
| **IR trigger mode** (`mode: ir`) — GPI beam polling, two-beam direction, burst + level-extension | ✅ |
| Passage detection → movement push (outbox → Nexus) | ✅ |
| Tag read/write/encode (`GET /tag`, `POST /tag/read`, `POST /tag/write`, TID-filtered writes) | ✅ |
| Power / antennas / work mode config | ✅ |
| Label printing — `tcp` transport (CP30 on LAN :9100, closed-loop verify) | ✅ |
| Label printing — `usb` transport via CUPS raw queue (`lp -o raw`) | ✅ |
| HW trigger mode (`mode: hw`, reader-side trigger + UDP push) | ❌ DLL only — use IR mode (it's the one with direction detection anyway) |
| USB-connected desktop readers (R1/R3 via `POST /connect-usb`) | ❌ DLL only — connect readers over TCP |

## Setup

```bash
# 1. Runtimes
sudo apt install -y nodejs npm default-jre-headless   # Node 18+, Java 11+

# 2. Bridge deps
cd bridge && npm install

# 3. Compile the sidecar once (or copy the .class files from a Windows checkout)
cd sidecar && javac -cp ReaderAPI20240822.jar UhfSidecar.java && cd ..

# 4. Env
cp .env.example .env   # set UR4_IP, NEXUS_URL, MOVEMENT_API_KEY, ...

# 5. Run
npm run dev
```

Then connect and arm IR mode as usual:

```bash
curl -X POST localhost:3001/connect
curl -X POST localhost:3001/mode -H 'Content-Type: application/json' -d '{"mode":"ir"}'
```

## Printing

- **tcp** (recommended): CP30 on the network, `PRINTER_TRANSPORT=tcp`,
  `PRINTER_HOST=<printer-ip>`. Identical behaviour to Windows, including the
  closed-loop ~HQES verify and physical-print tracking.
- **usb**: plug the CP30 in, create a raw CUPS queue, and set
  `PRINTER_NAME` to the queue name:

  ```bash
  sudo lpadmin -p CP30 -E -v "$(sudo lpinfo -v | awk '/usb:/{print $2; exit}')" -m raw
  ```

  Readiness (`/printer/status`) checks the queue is enabled and draining —
  CUPS, like the Windows spooler, happily accepts jobs with nothing attached.

## systemd unit

`/etc/systemd/system/rfid-bridge.service`:

```ini
[Unit]
Description=UR4 RFID bridge
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/test-rfid/bridge
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
User=pi
# .env is read by the bridge itself (dotenv) from WorkingDirectory

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now rfid-bridge
```

The sidecar is a child process of the bridge — it lives and dies with the
service; no separate unit needed.

## Notes

- The `data/` directory (printer state, print log, outbox journal, catalog
  cache) is created next to `src/` — make sure the service user can write it.
- Clock skew warning at boot matters double on a Pi with no RTC: keep
  `systemd-timesyncd` (or chrony) enabled, or gate timestamps drift.
