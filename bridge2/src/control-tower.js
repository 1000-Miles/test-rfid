'use strict';

/**
 * control-tower.js — hardware health reporting for Nexus → Operations → Control
 * Tower (/operations/control-tower).
 *
 * WHAT IT DOES
 * ------------
 * Every tick it: checks the office link this machine sits on (WiFi/ethernet,
 * gateway, DNS, internet), pulls a device work list from Nexus, checks whatever
 * is due, and POSTs the results back. Nothing is manual and no browser is
 * involved — the answers exist at 3am with every screen off, which is when
 * hardware actually breaks.
 *
 * WHY IT LIVES IN THE BRIDGE
 * --------------------------
 * Nexus runs on Vercel and cannot route to the warehouse LAN, so it can never be
 * the one asking "is that reader up?". Two earlier designs (probe from the
 * browser; a separate service on this PC) both worked for plain network devices
 * and both failed on ANTENNAS — because an antenna has no IP. It is a socket on
 * the back of a reader, and the only witness is the reader itself. The UR4
 * accepts ONE connection and this process holds it, so a separate service could
 * never ask. In here, `uhf.getAntennaLink()` is already available.
 *
 * Living here also means nothing new to install, nothing new to keep running,
 * and no second copy of MOVEMENT_API_KEY.
 *
 * WIRING (src/server.js, after `controller` exists — one line):
 *
 *   const { startControlTower } = require('./control-tower');
 *   startControlTower({ controller, uhf, gateId: GATE_ID, log: (m, l) => controller.log(m, l) });
 *
 * Config comes from the env the bridge already carries: NEXUS_URL (its ORIGIN is
 * used — the control-tower endpoints live on the same deployment as the movement
 * ingest) and MOVEMENT_API_KEY. Set CONTROL_TOWER=off to disable.
 *
 * THE OUTAGE CASE
 * ---------------
 * If the office internet drops, this can still reach every device on the LAN but
 * cannot reach Nexus to say so — and that is exactly the window you most want a
 * record of. Results that fail to send are buffered to disk with their ORIGINAL
 * observation time and replayed when the link returns; the Nexus endpoint
 * honours that timestamp. Nexus separately notices the missing heartbeat and
 * marks the whole board last-known rather than showing stale green lights.
 *
 * THE ONE RULE
 * ------------
 * Never report health that wasn't verified. A fabricated green light stops
 * someone walking to the gate; a fabricated red one sends them there for
 * nothing. Every "could not find out" path resolves to 'unknown' with a reason —
 * never to a guess. Note in particular that uhf.getAntennaLink() returning null,
 * or throwing because the reader link is down, means WE DON'T KNOW, not "no
 * antennas connected".
 */

const { createConnection } = require('node:net');
const { lookup } = require('node:dns/promises');
const { execFile } = require('node:child_process');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir, hostname } = require('node:os');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const VERSION = '1.1.0';

// A reachable-but-sluggish device is the early warning that matters: a gate
// reader answering in 900ms is about to start dropping passages.
//
// The WiFi signal threshold deliberately does NOT live here. This reports the
// raw RSSI it measured and Nexus decides what counts as weak — one place to
// retune it, and no risk of the two disagreeing about what colour a reading is.
const WARN_LATENCY_MS = 500;
const CONNECT_TIMEOUT_MS = 4000;
const DEFAULT_TICK_MS = 30000;
/** How often the bridge re-announces its hardware. Slow on purpose — this
 *  changes at the speed of someone with a screwdriver. */
const ANNOUNCE_MS = 10 * 60 * 1000;

/** Type-specific "what to go look at" for a device that didn't answer. */
const OFFLINE_HINT = {
  wifi: 'No response from access point — connection lost.',
  reader: 'Reader unreachable — check power and network cable.',
  antenna: 'No signal on antenna port — check cable connection.',
  printer_label: 'Printer offline — check power/USB and paper jam.',
  printer_rfid: 'RFID printer unreachable — check power and connection.',
  software: 'Service is not answering — restart may be required.',
};

// ── device checks ───────────────────────────────────────────────────────────

/**
 * Open a TCP connection and close it. This is the check a browser could never
 * do — a browser only speaks HTTP, which is why the first design needed an HTTP
 * /probe endpoint here. In-process, we just open the socket.
 */
// Socket errors that mean "we could not perform the check", as opposed to "the
// device did not answer". Reporting these as Offline invents a fault: the local
// stack, the route or DNS failed before anything reached the device, and the
// honest verdict is that we do not know.
const CANT_TELL_CODES = new Set([
  'ENETUNREACH',   // no route out of this machine
  'EHOSTUNREACH',  // no route to that subnet
  'EACCES',        // blocked locally (firewall / policy)
  'EPERM',
  'EAFNOSUPPORT',
  'EMFILE',        // out of file descriptors on THIS machine
  'ENFILE',
  'ENOTFOUND',     // hostname did not resolve
  'EAI_AGAIN',     // DNS itself was unreachable
]);

function tcpConnect(host, port) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok, detail, cantTell) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, cantTell: cantTell === true, latencyMs: Date.now() - startedAt, detail });
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish(true, `Connected to ${host}:${port}`));
    // A timeout IS a verdict about the device: something is listening at that
    // address or nothing is, and either way it did not answer in time.
    socket.once('timeout', () => finish(false, `Timed out connecting to ${host}:${port}`));
    socket.once('error', (err) => {
      const code = err.code || 'error';
      finish(false, `${code} connecting to ${host}:${port}`, CANT_TELL_CODES.has(code));
    });
  });
}

/**
 * ICMP ping, for a device with no open TCP port to knock on — an access point
 * being the usual case. Shells out because raw ICMP needs elevated privileges
 * and this runs as whatever account the bridge already runs as.
 */
/**
 * Output that means "this machine could not send the packet", not "the device
 * did not answer".
 *
 * tcpConnect already draws this line via CANT_TELL_CODES (ENETUNREACH and
 * friends). ping() did not, and the difference showed: an 'Office WiFi' row
 * pointing at 192.168.0.1 was reported "No response from access point —
 * connection lost" by gate PCs that are wired to 192.168.1.x and have no route
 * to that network at all. The access point was fine. The bridge simply cannot
 * see it from where it stands, and saying anything else is inventing a fault.
 *
 * 'Destination host unreachable' is deliberately NOT here: that comes from a
 * router that COULD reach the network and found nothing at the address, which
 * is real evidence about the device.
 */
const NO_ROUTE_OUTPUT = [
  'network is unreachable',   // linux: no route off this machine
  'no route to host',
  'name or service not known', // dns failed; nothing was ever sent
  'unknown host',
  'could not find host',
  'general failure',           // windows: no usable interface
  'transmit failed',
  'operation not permitted',   // raw socket refused by policy
  'permission denied',
];

function pingCouldNotSend(output) {
  const text = String(output || '').toLowerCase();
  return NO_ROUTE_OUTPUT.find((phrase) => text.includes(phrase)) || null;
}

async function ping(host) {
  const isWindows = process.platform === 'win32';
  const args = isWindows
    ? ['-n', '1', '-w', String(CONNECT_TIMEOUT_MS), host]
    : ['-c', '1', '-W', '4', host];
  try {
    const { stdout } = await execFileAsync('ping', args, { timeout: CONNECT_TIMEOUT_MS + 2000 });
    // 'time=12ms' / 'time<1ms' / localised equivalents.
    const m = stdout.match(/[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
    // Match on TTL rather than exit code: Windows' ping exits 0 even for
    // "Destination host unreachable", so the exit status is not a verdict.
    const ok = /ttl[=\s]/i.test(stdout);
    const blocked = ok ? null : pingCouldNotSend(stdout);
    if (blocked) {
      return {
        ok: false,
        cantTell: true,
        latencyMs: null,
        detail: `This bridge has no route to ${host} (${blocked}), so it cannot be checked from here.`,
      };
    }
    return {
      ok,
      cantTell: false,
      latencyMs: m ? Math.round(Number(m[1])) : null,
      detail: ok ? `Ping replied${m ? ` in ${m[1]}ms` : ''}` : `No ping reply from ${host}`,
    };
  } catch (err) {
    // execFile rejects both when ping RAN and reported failure (non-zero exit,
    // which still carries stdout) and when ping could not run at all. Only the
    // first is a verdict about the device.
    const out = `${(err && err.stdout) || ''}\n${(err && err.stderr) || ''}`.trim();
    if (out) {
      const ok = /ttl[=\s]/i.test(out);
      // Same line as above: could-not-send is not a verdict. ping writes this to
      // stdout AND exits non-zero, so it arrives here rather than in the success
      // path — which is exactly how it was being read as "the device is down".
      const blocked = ok ? null : pingCouldNotSend(out);
      if (blocked) {
        return {
          ok: false,
          cantTell: true,
          latencyMs: null,
          detail: `This bridge has no route to ${host} (${blocked}), so it cannot be checked from here.`,
        };
      }
      const m = out.match(/[=<]\s*(\d+(?:\.\d+)?)\s*ms/i);
      return {
        ok,
        cantTell: false,
        latencyMs: m ? Math.round(Number(m[1])) : null,
        detail: ok ? 'Ping replied' : `No ping reply from ${host}`,
      };
    }
    // No output at all: the tool is missing, blocked by policy, or was killed.
    // That says nothing about the device.
    const code = (err && (err.code || err.errno)) || 'error';
    return {
      ok: false,
      cantTell: true,
      latencyMs: null,
      detail: `Could not run ping (${code}) — the check did not reach ${host}.`,
    };
  }
}


// -- per-antenna read activity -----------------------------------------------
//
// This is the ONLY trustworthy antenna signal on this firmware, and it is a good
// one: the reader stamps every tag read with the port it came in on, so a port
// that is producing reads is demonstrably working — cable, connector, bracket and
// all. No self-report call can say as much.
//
// The reader's own introspection is documented as unreliable here (uhf.js):
//   UHFGetAntennaLinkStatus  returns non-zero on this unit -> null
//   UHFGetANT                returns 0 but leaves the buffer unwritten
//   UHFGetAntennaPower       returns non-zero, cannot be read back
// which is why "physically connected?" came back Unchecked. It was not a missing
// feature; the hardware would not answer.
//
// Kept on disk so a bridge restart does not blind every antenna until the next
// pallet goes through.
const ANTENNA_STATE_FILE = 'control-tower-antennas.json';

/**
 * How recently a port must have read for that read to still vouch for it.
 *
 * A day, not the two hours this used to be. Per-port traffic is far thinner
 * than the gate's as a whole — one gate logged 4229 reads on port 3 and 1 on
 * port 4 over the same window — so a short window turned working antennas into
 * Unchecked every evening.
 */
const ANTENNA_QUIET_MS = 24 * 60 * 60 * 1000;

const antennaReads = new Map(); // port -> { last: epochMs, count: number }
let antennaDirty = false;

function antennaStatePath() {
  return join(__dirname, '..', 'data', ANTENNA_STATE_FILE);
}

function loadAntennaReads() {
  try {
    const raw = JSON.parse(readFileSync(antennaStatePath(), 'utf8'));
    for (const [port, v] of Object.entries(raw.ports || {})) {
      const n = Number(port);
      if (Number.isFinite(n) && v && Number.isFinite(v.last)) {
        antennaReads.set(n, { last: v.last, count: Number(v.count) || 0 });
      }
    }
  } catch {
    // first run, or the file is unreadable — start from nothing
  }
}

function saveAntennaReads(log) {
  if (!antennaDirty) return;
  antennaDirty = false;
  try {
    mkdirSync(dirname(antennaStatePath()), { recursive: true });
    const ports = {};
    for (const [port, v] of antennaReads) ports[port] = v;
    writeFileSync(antennaStatePath(), JSON.stringify({ ports }), 'utf8');
  } catch (err) {
    log(`could not save antenna read state: ${err.message}`, 'warn');
  }
}

/** Called for every tag the reader reports. Hot path — keep it trivial. */
function noteAntennaRead(port) {
  const n = Number(port);
  if (!Number.isFinite(n) || n <= 0) return;
  const cur = antennaReads.get(n);
  if (cur) {
    cur.last = Date.now();
    cur.count += 1;
  } else {
    antennaReads.set(n, { last: Date.now(), count: 1 });
  }
  antennaDirty = true;
}

/** Ports seen reading at all — the honest answer to "how many antennas?". */
function portsSeenReading() {
  return [...antennaReads.keys()].sort((a, b) => a - b);
}


/**
 * How long an antenna-link reading stays good for.
 *
 * Two hours, because that is the honest cadence: an antenna changes when
 * somebody unplugs one, not on a five-minute tick. Asking more often would put
 * monitoring traffic on the reader's wire for no new information.
 */
const ANTENNA_LINK_TTL_MS = 2 * 60 * 60 * 1000;

/** Last answer, and when. Shared by all four antenna rows — one question, four verdicts. */
let antennaLinkCache = { at: 0, ports: null };

/**
 * The reader's antenna-link reading, cached, and never taken mid-passage.
 *
 * Two rules, both about staying out of the gate's way:
 *
 *   1. If the reader is reading, do not ask. A pallet going through is the one
 *      moment this must not add traffic, and it is also the moment the answer
 *      matters least. The previous reading stands.
 *   2. One question per two hours, not one per antenna per tick. Four antennas
 *      on a 5-minute tick would otherwise be 48 questions an hour to learn a
 *      fact that changes when someone brings a ladder.
 *
 * A failed or refused read does NOT restamp the clock, so it retries on the next
 * tick rather than going quiet for two hours.
 */
async function antennaLinkPorts(ctx) {
  const fresh = Date.now() - antennaLinkCache.at < ANTENNA_LINK_TTL_MS;
  if (fresh) return antennaLinkCache.ports;
  if (ctx.controller && ctx.controller.reading) return antennaLinkCache.ports;
  if (!ctx.uhf || typeof ctx.uhf.getAntennaLink !== 'function') return null;

  const ports = await ctx.uhf.getAntennaLink();
  if (Array.isArray(ports)) {
    antennaLinkCache = { at: Date.now(), ports };
    return ports;
  }
  return antennaLinkCache.ports;
}

/**
 * The antenna check — the one that only works from in here.
 *
 * uhf.getAntennaLink() is the UR4's own answer to "which ports have an antenna
 * physically connected" (UHFGetAntennaLinkStatus). It is guarded by requireLink,
 * so it THROWS when the reader link is down — which is "we can't find out",
 * emphatically not "nothing is connected". Same for a null return.
 */
async function checkAntenna(device, ctx) {
  const unknown = (detail) => ({ status: 'unknown', issue: null, detail, latencyMs: null });

  if (!device.antennaPort) return unknown('No antenna port set for this antenna.');
  const port = Number(device.antennaPort);
  if (!ctx.uhf) return unknown('This bridge build has no reader module wired.');

  const now = Date.now();
  const mine = antennaReads.get(port);
  const readNote = mine
    ? ` Last read ${Math.max(1, Math.round((now - mine.last) / 60000))}m ago (${mine.count} reads on this port).`
    : '';

  // ---- 1. ask the reader whether an antenna is PRESENT on this port -------
  //
  // Asked first because it is the only thing that can tell a broken antenna
  // from a quiet one. On the DLL driver (Windows) UHFGetAntennaLinkStatus
  // sometimes answers. On the Java sidecar, which is what BOTH live gates
  // actually run, it cannot: RFIDWithUHFNetworkUR4 exposes setAntenna /
  // getAntenna / power / work-time and nothing else — there is no link, VSWR or
  // presence call in that SDK at all. So this branch is a bonus, not the plan,
  // and everything below has to work without it.
  let connectedPorts = null;
  try {
    connectedPorts = await antennaLinkPorts(ctx);
  } catch (err) {
    return unknown(`Reader link is down, so its antenna ports cannot be read (${err.message}).${readNote}`);
  }

  if (Array.isArray(connectedPorts)) {
    if (!connectedPorts.includes(port)) {
      // A definite NO from the reader. The only case that earns Offline.
      return {
        status: 'offline',
        issue: OFFLINE_HINT.antenna,
        detail:
          `Reader reports no antenna on port ${port}` +
          (connectedPorts.length ? ` (connected: ${connectedPorts.join(', ')}).` : ' (no ports connected).') +
          readNote,
        latencyMs: null,
      };
    }

    // Present. Still worth checking the port is enabled: an antenna that is
    // plugged in but switched off reads nothing and looks fine to everything else.
    let enabled = null;
    try {
      enabled = await ctx.uhf.getAntennas();
    } catch {
      enabled = null;
    }
    if (Array.isArray(enabled) && enabled.length > 0 && !enabled.includes(port)) {
      return {
        status: 'warning',
        issue: `Antenna is connected but port ${port} is disabled on the reader.`,
        detail: `Enabled ports: ${enabled.join(', ')}.${readNote}`,
        latencyMs: null,
      };
    }

    let power = null;
    try {
      power = await ctx.uhf.getAntennaPower();
    } catch {
      power = null;
    }
    const dBm = power && power[port] ? power[port].read : null;
    return {
      status: 'online',
      issue: null,
      detail:
        `Reader reports an antenna connected on port ${port}` +
        (dBm != null ? ` at ${dBm} dBm.` : '.') +
        readNote,
      latencyMs: null,
    };
  }

  // ---- 2. no presence API — fall back to what the port has actually done ---
  //
  // A port that produced reads is working, cable and bracket and all. No
  // self-report could say as much, so this is a strong YES.
  if (mine && now - mine.last < ANTENNA_QUIET_MS) {
    return {
      status: 'online',
      issue: null,
      detail: `Read a tag ${Math.max(1, Math.round((now - mine.last) / 60000))}m ago (${mine.count} reads on this port).`,
      latencyMs: null,
    };
  }

  // ---- 3. silence, which proves nothing ------------------------------------
  //
  // An earlier version called a port Offline when it was quiet while its
  // siblings were reading. That was wrong, and the gate's own numbers show how
  // wrong: over the same window ports 1 and 3 logged 2187 and 4229 reads while
  // ports 2 and 4 logged 8 and 1. All four work. They are aimed at different
  // parts of the opening, so a pallet down one side is seen by some and not
  // others, and any short-window comparison between ports flags healthy
  // hardware. Silence means "nothing came past this antenna" — never "this
  // antenna is broken".
  //
  // So there is no verdict to give. Unchecked, with the reason, and it resolves
  // itself the next time something goes through.
  const others = [...antennaReads.entries()].filter(([p]) => p !== port);
  const othersActive = others.filter(([, v]) => now - v.last < ANTENNA_QUIET_MS).map(([p]) => p);
  const seenBefore = mine
    ? `This port last read ${Math.round((now - mine.last) / 3600000)}h ago.`
    : 'This port has not read a tag since the bridge started watching.';
  return unknown(
    `${seenBefore} This reader will not report whether an antenna is connected, so a quiet port cannot be told` +
      ` apart from a working one until a tag passes it.` +
      (othersActive.length ? ` Port${othersActive.length > 1 ? 's' : ''} ${othersActive.join(', ')} read recently.` : ''),
  );
}

/**
 * Printers, asked through the PrinterManager rather than knocked on.
 *
 * This is a much better answer than a TCP connect. The Windows spooler accepts
 * jobs with no printer attached, so port 9100 answering proves almost nothing —
 * checkReady() is the verdict the print path itself gates on.
 */
/**
 * Is a queue-backed printer actually PLUGGED IN?
 *
 * The readiness check the print path uses answers a different question than the
 * one this light asks. `lpstat -p` on an enabled queue with nothing in it says
 * "idle" whether or not a printer is on the end of the cable, so an empty queue
 * on a gate with no label printer at all reported Online. That is the worst kind
 * of green: it says a thing exists that does not.
 *
 * CUPS does know, it just does not say it there. `lpstat -v <queue>` gives the
 * queue's device URI and `lpinfo -v` lists the devices actually present right
 * now — an unplugged USB printer drops out of the second list while keeping its
 * queue in the first. Comparing them is the presence check.
 *
 * Deliberately implemented HERE rather than in printer/index.js: that file is
 * the path that prints real labels, and a monitoring question has no business
 * being added to it.
 *
 * @returns {Promise<boolean|null>} null means "could not find out" — never false.
 */
async function cupsPrinterPresent(queueName) {
  if (!queueName || process.platform === 'win32') return null;
  let uri = null;
  try {
    const { stdout } = await execFileAsync('lpstat', ['-v', queueName], { timeout: 8000 });
    const m = stdout.match(/device for [^:]+:\s*(\S+)/i);
    uri = m ? m[1].trim() : null;
  } catch {
    return null; // no lpstat, or the queue vanished — checkPrinter's own probe covers that
  }
  if (!uri) return null;

  // Only local attachments are answerable this way. A networked queue points at
  // socket:// or ipp:// and is judged by its address, which is a better check.
  if (!/^(usb|serial|parallel|hp|hpfax):/i.test(uri)) return null;

  try {
    const { stdout } = await execFileAsync('lpinfo', ['-v'], { timeout: 10000 });
    // URIs carry a ?serial=... suffix that can differ between the two commands,
    // so compare the part before the query string.
    const base = uri.split('?')[0];
    return stdout.split('\n').some((line) => line.includes(base));
  } catch {
    return null; // lpinfo is often root-only; not knowing is not evidence
  }
}

async function checkPrinter(device, ctx) {
  // ---- a printer with an address is judged by the address ------------------
  //
  // If it answers, it is on, plugged in and listening. That is what the light is
  // asking. An earlier version led with the bridge's print path instead and
  // reported a printer that was answering on 9100 as "unreachable — check power
  // and connection", which is the worst kind of wrong: it sends someone across
  // the warehouse to look at a printer that is working.
  //
  // The queue is a SEPARATE thing — whether this gate PC has the printer set up
  // under the name the bridge prints to. Worth saying in the detail so it gets
  // fixed, but it is not the printer being down and must not colour the light.
  //
  // The bridge does this knock, not the browser: the PC someone opens Control
  // Tower on is not on the warehouse network and could never reach 192.168.1.x.
  if (device.ip) {
    const knock = device.port
      ? await tcpConnect(device.ip, device.port)
      : await ping(device.ip);

    if (knock.cantTell) {
      return { status: 'unknown', issue: null, detail: knock.detail, latencyMs: null };
    }

    if (!knock.ok) {
      return {
        status: 'offline',
        issue: OFFLINE_HINT[device.type] || 'Printer not answering.',
        detail: knock.detail,
        latencyMs: null,
      };
    }

    const queueNote = await printQueueNote(device, ctx);
    return {
      status: 'online',
      issue: null,
      detail: `${knock.detail}${queueNote}`,
      latencyMs: knock.latencyMs ?? null,
    };
  }

  // ---- no address: the print path is all there is --------------------------
  //
  // A pallet printer hangs off the gate PC by USB and has no address to knock
  // on, so here the queue really is the check: no queue means no way to print.
  if (!ctx.printer) return null;
  const isPallet = printerIsPallet(device);
  let r;
  try {
    r = isPallet ? await ctx.printer.checkPalletReady() : await ctx.printer.checkReady();
  } catch {
    return null; // fall through to the plain network check
  }
  if (!r || typeof r.ready !== 'boolean') return null;

  if (!r.ready) {
    return {
      status: 'offline',
      issue: OFFLINE_HINT[device.type] || 'Printer not ready.',
      detail: r.detail || 'Printer reported not ready.',
      latencyMs: null,
    };
  }

  // The queue says it would accept a job. That is not the same as a printer
  // being on the end of it, so ask whether the device is actually attached.
  const queueName = isPallet
    ? ctx.printer.config && ctx.printer.config.palletPrinterName
    : ctx.printer.config && ctx.printer.config.printerName;
  const present = await cupsPrinterPresent(queueName);

  if (present === false) {
    return {
      status: 'offline',
      issue: `Queue "${queueName}" is set up, but no printer is attached to this PC.`,
      detail: `${r.detail || 'Queue ready.'} The device is not in lpinfo -v, so nothing is plugged in.`,
      latencyMs: null,
    };
  }

  if (present === null) {
    return {
      status: 'unknown',
      issue: null,
      detail:
        `${r.detail || 'Queue ready.'} A queue accepts jobs whether or not a printer is plugged ` +
        `into it, and this machine could not be asked which — so being ready is not proof it is there.`,
      latencyMs: null,
    };
  }

  return { status: 'online', issue: null, detail: r.detail || 'Printer ready.', latencyMs: null };
}

/**
 * Which printer this row IS decides which readiness check answers for it. The
 * two are different devices with different queues, so running the carton check
 * against the pallet printer would report an out-of-media Gprinter as healthy.
 * sourceKey comes back on the work list precisely so this can be told apart;
 * without one (a hand-added row) fall back to the type.
 */
function printerIsPallet(device) {
  const key = device.sourceKey || '';
  return key ? key.endsWith(':printer:pallet') : device.type === 'printer_label';
}

/** A trailing sentence when the gate PC has no queue for a reachable printer. */
async function printQueueNote(device, ctx) {
  if (!ctx.printer) return '';
  try {
    const r = printerIsPallet(device)
      ? await ctx.printer.checkPalletReady()
      : await ctx.printer.checkReady();
    if (!r || typeof r.ready !== 'boolean' || r.ready) return '';
    return ` Not set up to print from this PC yet: ${r.detail || 'no print queue found'}.`;
  } catch {
    return '';
  }
}

/**
 * A reader whose link this process holds can be ASKED, not merely knocked on.
 * "Connected but not reading" is a real fault that a TCP knock calls healthy.
 */
function checkReaderViaLink(device, ctx) {
  if (!ctx.controller) return null;
  if (device.gateId && ctx.gateId && device.gateId !== ctx.gateId) return null;

  if (!ctx.controller.connected) {
    return {
      status: 'offline',
      issue: OFFLINE_HINT.reader,
      detail: 'Bridge has no open link to the reader.',
      latencyMs: null,
    };
  }
  // NOT reading is not a fault.
  //
  // This gate runs in IR mode (NEXUS_DETECT_MODE defaults to 'ir'), where an
  // inventory cycle is started by the beam being broken and stops again after the
  // passage. So `reading === false` is the NORMAL resting state between pallets —
  // warning on it meant a healthy gate showed amber all day and the word stopped
  // meaning anything.
  //
  // Whether the reader is actually doing its job is answered elsewhere, and
  // better: Nexus watches the tag traffic for this gate and drops the reader to
  // warning if nothing has been read for GATE_SILENT_WARN_MS. That is evidence,
  // where this was a guess about a flag.
  return {
    status: 'online',
    issue: null,
    detail: ctx.controller.reading
      ? 'Reader link open, inventory running.'
      : 'Reader link open, waiting for a passage.',
    latencyMs: null,
  };
}

/**
 * Check one device. Returns null to mean "not mine, skip it" — used when a
 * second gate's bridge sees rows it cannot witness.
 */
/**
 * Is this row another gate's to answer for?
 *
 * The work list is global: with gate 1 and gate 2 both running, each bridge sees
 * every device in Nexus. Reader and antenna rows must only ever be judged by the
 * bridge that HOLDS that reader's link, for two reasons:
 *
 *   1. Only it can answer at all for an antenna — the reader takes one
 *      connection and that bridge has it.
 *   2. For a reader it has the BETTER answer. Gate 1's bridge can say "connected
 *      but not reading"; gate 2 could only knock on the port and call that
 *      healthy. Letting the weaker check also write means whichever reported
 *      last wins, and a real warning silently becomes Online.
 *
 * Skipping is safe: if the owning bridge is down, nobody reports its devices,
 * they go stale, and the board says so — which is the truth.
 */
function belongsToAnotherGate(device, ctx) {
  if (device.type !== 'reader' && device.type !== 'antenna') return false;
  return Boolean(device.gateId && ctx.gateId && device.gateId !== ctx.gateId);
}

/**
 * Whether THIS machine is entitled to report on a router row.
 *
 * The 'shared:lan' and 'shared:wifi' rows have no gateId, so every bridge checks
 * them — which is right when both bridges sit behind the router, and wrong the
 * moment one of them doesn't. A gate PC wired to the warehouse switch has no
 * route to the office WiFi router at all: it would ping 192.168.0.1, get
 * nothing, report Offline, and overwrite the verdict of the bridge that IS on
 * that WiFi and can see it working. One machine's blind spot would become
 * everyone's outage.
 *
 * So a router row is answered only by a machine that routes through it. A bridge
 * that doesn't stays quiet (null), the same as it does for another gate's reader.
 * Non-router rows are unaffected.
 */
async function routerRowIsOurs(device) {
  if (!/:(?:lan|wifi)(?::|$)/.test(device.sourceKey || '')) return true;
  if (!device.ip) return true;
  const gateways = await cachedGateways();
  // No route table at all (a platform or permissions miss) is not evidence of
  // anything — fall through and let the ping speak, as it did before.
  if (gateways.length === 0) return true;
  return gateways.some((g) => g.host === device.ip);
}

async function checkDevice(device, ctx) {
  const at = new Date().toISOString();
  // Set below for the office WiFi row, whose detail carries the radio's own
  // reading as well as the ping. Appended rather than replacing, so a device
  // with no detail still reports null instead of an empty string.
  let detailSuffix = '';
  const wrap = (r) =>
    r
      ? Object.assign(
          { id: device.id, at },
          r,
          detailSuffix ? { detail: (r.detail || '') + detailSuffix } : null,
        )
      : null;

  // Not ours to answer for. Returning null sends nothing at all for this row.
  if (belongsToAnotherGate(device, ctx)) return null;
  if (!(await routerRowIsOurs(device))) return null;

  // Antennas are not hosts. Ask the reader.
  if (device.type === 'antenna') return wrap(await checkAntenna(device, ctx));

  // A reader whose link we hold: ask it. Otherwise fall through to the network.
  if (device.type === 'reader') {
    const viaLink = checkReaderViaLink(device, ctx);
    if (viaLink) return wrap(viaLink);
  }

  // A printer this bridge drives: ask the print path's own readiness check.
  if (device.type === 'printer_label' || device.type === 'printer_rfid') {
    const viaPrinter = await checkPrinter(device, ctx);
    if (viaPrinter) return wrap(viaPrinter);
  }

  // The middleware row: no address because the device IS this bridge. Claiming
  // online is sound rather than optimistic — this code is executing inside the
  // process being asked about, so its liveness is not in question.
  //
  // Restricted to 'software' deliberately. As a blanket "no ip means it's us" it
  // was wrong the moment a second gate existed: any address-less row from the
  // other gate would have been reported healthy on the strength of THIS process
  // being alive.
  if (device.type === 'software' && !device.ip) {
    return wrap({ status: 'online', issue: null, detail: 'Bridge process is running.', latencyMs: 0 });
  }

  // Anything else with no address cannot be checked from here at all.
  if (!device.ip) {
    return wrap({
      status: 'unknown',
      issue: null,
      detail: 'No address set, and this bridge has no other way to reach it.',
      latencyMs: null,
    });
  }

  // The office WiFi row is about the RADIO as much as the router it pings.
  //
  // A ping to the gateway answers "can this machine get off the WiFi", which is
  // the question IT is asked; but "it answered in 2ms" is a thin thing to read
  // when someone reports the warehouse WiFi being flaky. So the row also carries
  // what the adapter is actually seeing — SSID, signal, link rate.
  //
  // Deliberately only the DESCRIPTION. Whether a signal counts as weak is Nexus's
  // call, for the reason given at WARN_LATENCY_MS: one place to retune it, and no
  // risk of the bridge and the board disagreeing about what colour a reading is.
  // Nothing here changes the status.
  if (/:wifi(?::|$)/.test(device.sourceKey || '')) {
    detailSuffix = await wifiRadioNote();
  }

  const r = device.port
    ? await tcpConnect(device.ip, device.port)
    : await ping(device.ip).then((p) => ({
        ok: p.ok,
        cantTell: p.cantTell,
        latencyMs: p.latencyMs || 0,
        detail: p.detail,
      }));

  // The check could not be performed. NOT the same as the device being down, and
  // reporting it as Offline would send someone to the gate for nothing. Nexus
  // records the reason and leaves the previous status and its staleness clock
  // alone (see the report route).
  if (r.cantTell) {
    return wrap({ status: 'unknown', issue: null, detail: r.detail, latencyMs: null });
  }

  if (!r.ok) {
    return wrap({
      status: 'offline',
      issue: OFFLINE_HINT[device.type] || 'Not answering.',
      detail: r.detail,
      latencyMs: null,
    });
  }
  if (r.latencyMs > WARN_LATENCY_MS) {
    return wrap({
      status: 'warning',
      issue: `Slow to respond (${r.latencyMs}ms) — check network load.`,
      detail: r.detail,
      latencyMs: r.latencyMs,
    });
  }
  return wrap({ status: 'online', issue: null, detail: r.detail, latencyMs: r.latencyMs });
}

// ── the office network, from the machine that's actually on it ──────────────

/** Windows WiFi details. Nulls on a wired machine or a parse miss. */
async function wifiLink() {
  const empty = {
    type: 'unknown', ssid: null, signalPercent: null, rssiDbm: null, linkSpeedMbps: null, adapter: null,
  };
  if (process.platform !== 'win32') return empty;
  try {
    const { stdout } = await execFileAsync('netsh', ['wlan', 'show', 'interfaces'], { timeout: 8000 });
    const grab = (label) => {
      const m = stdout.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'im'));
      return m ? m[1].trim() : null;
    };
    const ssid = grab('SSID');
    // A WiFi radio that exists but isn't associated is not "unknown" — this
    // machine is on the wire.
    if (!ssid) return Object.assign({}, empty, { type: 'ethernet' });
    const signalRaw = grab('Signal');
    const signalPercent = signalRaw ? Number(signalRaw.replace('%', '').trim()) : null;
    const speed = Number(grab('Receive rate \\(Mbps\\)'));
    return {
      type: 'wifi',
      ssid,
      signalPercent: Number.isFinite(signalPercent) ? signalPercent : null,
      // netsh reports a percentage, not dBm. Microsoft's documented mapping is
      // linear across [-100, -50], so this restates what the OS said rather than
      // inventing a measurement.
      rssiDbm: Number.isFinite(signalPercent) ? Math.round(signalPercent / 2 - 100) : null,
      linkSpeedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
      adapter: grab('Name'),
    };
  } catch {
    return empty;
  }
}

/** Interface names that mean 'this route goes out over the air'. */
const WIRELESS_IFACE = /wi[\s-]?fi|wireless|wlan|^wl\d/i;

/**
 * EVERY default gateway, not just the best one.
 *
 * This site has two: the warehouse switch on 192.168.1.1 over Ethernet and the
 * office WiFi router on 192.168.0.1, both at route metric 0. The old version
 * sorted by metric and took the first, so it monitored the wire and never
 * noticed the WiFi router go down — the one outage most likely to be noticed by
 * people and least likely to be noticed by us.
 *
 * Sorted best-first (the first entry is still 'the' gateway for the boot
 * summary), deduped by address, so a machine with one route behaves exactly as
 * it did before.
 */
/** Route tables change at the speed of someone moving a cable. */
const GATEWAY_CACHE_MS = 60000;
let gatewayCache = { at: 0, value: [] };

/** defaultGateways(), memoised — the check tick asks far more often than routes move. */
async function cachedGateways() {
  if (Date.now() - gatewayCache.at < GATEWAY_CACHE_MS) return gatewayCache.value;
  const value = await defaultGateways();
  gatewayCache = { at: Date.now(), value };
  return value;
}

async function defaultGateways() {
  const out = [];
  const add = (host, iface) => {
    const h = String(host || '').trim();
    if (!h || h === '0.0.0.0' || h === '::') return;
    if (out.some((g) => g.host === h)) return;
    out.push({ host: h, iface: String(iface || '').trim() || null, wireless: WIRELESS_IFACE.test(iface || '') });
  };
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object NextHop,InterfaceAlias | ConvertTo-Json -Compress`,
        ],
        { timeout: 10000 },
      );
      const parsed = JSON.parse(stdout.trim() || 'null');
      // ConvertTo-Json emits a bare object when there is exactly one route.
      for (const r of Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) {
        add(r.NextHop, r.InterfaceAlias);
      }
      return out;
    }
    const { stdout } = await execFileAsync(
      'sh',
      ['-c', "ip -o route | awk '/^default/ {print $3, $5}'"],
      { timeout: 8000 },
    );
    for (const line of stdout.split('\n')) {
      const [host, iface] = line.trim().split(/\s+/);
      add(host, iface);
    }
    return out;
  } catch {
    return out;
  }
}

/**
 * What the WiFi adapter is seeing right now, as one sentence.
 *
 * Empty string on a wired machine or a parse miss — the ping still stands on its
 * own, so a missing radio reading costs nothing.
 */
async function wifiRadioNote() {
  const link = await wifiLink();
  if (link.type !== 'wifi') return '';
  const bits = [];
  if (link.signalPercent != null) {
    bits.push(`${link.signalPercent}% signal${link.rssiDbm != null ? ` (${link.rssiDbm} dBm)` : ''}`);
  }
  if (link.linkSpeedMbps != null) bits.push(`${link.linkSpeedMbps} Mbps`);
  if (link.ssid) bits.unshift(link.ssid);
  // Leading separator: this is glued onto the end of the ping's own sentence.
  return bits.length ? ` · ${bits.join(' · ')}` : '';
}

/** The primary gateway, for the one-line boot/network summary. */
async function defaultGateway() {
  const all = await defaultGateways();
  return all.length ? all[0].host : null;
}

async function checkNetwork() {
  const [link, gatewayHost] = await Promise.all([wifiLink(), defaultGateway()]);
  const gatewayPing = gatewayHost
    ? await ping(gatewayHost)
    : { ok: false, latencyMs: null, detail: 'No default gateway found' };

  // DNS and an outbound request are checked separately on purpose: a link where
  // names don't resolve is up but half-usable, which is a different callout from
  // "the line is dead".
  let dnsOk = false;
  let dnsLatency = null;
  let dnsDetail = null;
  const dnsStart = Date.now();
  try {
    await lookup('cloudflare.com');
    dnsOk = true;
    dnsLatency = Date.now() - dnsStart;
  } catch (err) {
    dnsDetail = (err && err.message) || 'DNS lookup failed';
  }

  let netOk = false;
  let netLatency = null;
  let netDetail = null;
  const netStart = Date.now();
  try {
    const res = await fetch('https://cloudflare.com/cdn-cgi/trace', {
      signal: AbortSignal.timeout(6000),
      cache: 'no-store',
    });
    netOk = res.ok;
    netLatency = Date.now() - netStart;
    if (!res.ok) netDetail = `Upstream answered HTTP ${res.status}`;
  } catch {
    netDetail = gatewayPing.ok
      ? 'The router answers, but nothing beyond it does.'
      : 'The router itself is unreachable.';
  }

  return {
    link,
    gateway: { host: gatewayHost, reachable: gatewayPing.ok, latencyMs: gatewayPing.latencyMs },
    dns: { ok: dnsOk, latencyMs: dnsLatency, detail: dnsDetail },
    internet: { ok: netOk, latencyMs: netLatency, target: 'cloudflare.com', detail: netDetail },
  };
}

/**
 * The printer config this bridge has actually SAVED, or null if it never has.
 *
 * Read straight off disk rather than through PrinterManager, because the manager
 * merges the file over placeholder defaults and that erases the one distinction
 * that matters here: whether a printer was ever configured at all. Same path the
 * manager writes (printer/index.js STATE_PATH), one directory shallower because
 * this file sits in src/ rather than src/printer/.
 */
function persistedPrinterConfig() {
  try {
    const raw = readFileSync(join(__dirname, '..', 'data', 'printer.json'), 'utf8');
    const state = JSON.parse(raw);
    return state && state.config ? state.config : null;
  } catch {
    // No file: nothing has been configured or printed on this bridge.
    return null;
  }
}

// -- self-registration ------------------------------------------------------

/**
 * Everything this bridge can truthfully say it has, ready to announce.
 *
 * The point is that IT types nothing. The reader's address, which antenna ports
 * are enabled, both printers' queues and hosts — this process already holds all
 * of it, and a form asking a human to copy it in would only go stale the moment
 * a cable moved.
 *
 * `sourceKey` is derived from the thing itself so announcing repeatedly updates
 * one row rather than piling up copies.
 *
 * Only things we can actually witness are announced. Notably we do NOT invent a
 * WiFi access point: this machine knows its default gateway, which is the router
 * it goes through, and that is announced honestly as the router — not dressed up
 * as an AP whose signal we never measured.
 */
async function discoverDevices(ctx) {
  const gate = ctx.gateId || 'gate';

  // The zone NAME is deliberately separate from the gate's identity.
  //
  // GATE_ID is permanent: it is half of every movement's immutable event id
  // (`gateId:seq`), so it cannot be renamed to suit a board. Deriving the zone
  // from it meant a site whose gates are called 'yiwu-main-gate' and
  // 'yiwu-gate-2' got zones named after those ids, sitting alongside the Gate 1
  // and Gate 2 zones people actually wanted to read.
  //
  // CONTROL_TOWER_ZONE is that board label, set per bridge:
  //   bridge1/.env  CONTROL_TOWER_ZONE=Gate 1
  //   bridge2/.env  CONTROL_TOWER_ZONE=Gate 2
  // Unset, it falls back to the prettified id, which is right for a site whose
  // ids already read well.
  const zoneName = (process.env.CONTROL_TOWER_ZONE || '').trim() || prettyGate(gate);
  const out = [];

  // The bridge does NOT announce itself as a device.
  //
  // It used to, and the row was redundant: the bridge's own liveness is the
  // heartbeat, and the dashboard's connection card is built from exactly that.
  // A device row saying "the thing that reports is reporting" adds a line to
  // every gate and tells you nothing the card above it did not.
  //
  // CONTROL_TOWER_ANNOUNCE_SELF=1 puts it back for a site that wants per-gate
  // bridge rows on the board — worth it if you run several gates and want each
  // one's service visible in the list rather than only in the header.
  if (/^(1|true|yes|on)$/i.test(process.env.CONTROL_TOWER_ANNOUNCE_SELF || '')) {
    out.push({
      sourceKey: `${gate}:bridge`,
      type: 'software',
      name: 'RFID Bridge',
      zoneName,
      ip: null,
      port: null,
      frequencyMinutes: 5,
      checkNote: 'Confirms the gate bridge service is running and reporting.',
    });
  }

  // The reader. Address from the live link where we have one, else the
  // configured default — never a guess.
  const readerIp = ctx.readerIp || null;
  const readerPort = ctx.readerPort || null;
  out.push({
    sourceKey: `${gate}:reader`,
    type: 'reader',
    name: 'Gate Reader',
    zoneName,
    ip: readerIp,
    port: readerPort,
    gateId: gate,
    frequencyMinutes: 5,
    checkNote: 'Confirms the reader link is open and an inventory cycle is running.',
  });

  // Antennas: one row per ENABLED port. Enabled is the right list — those are
  // the ports the gate is meant to be using, so a cable pulled from one of them
  // is a fault. A port nobody enabled is not a missing antenna.
  // How many antennas this gate has.
  //
  // getAntennas() is NOT reliable here: uhf.js records that UHFGetANT returns 0
  // while leaving the output buffer unwritten on this firmware, which is why a
  // four-antenna gate announced one antenna. So the order of preference is:
  //   1. CONTROL_TOWER_ANTENNAS  — what the site says it installed, e.g. 4
  //   2. ports actually seen reading tags
  //   3. whatever getAntennas() claims
  let ports = null;
  const declared = (process.env.CONTROL_TOWER_ANTENNAS || '').trim();
  if (declared) {
    ports = /^\d+$/.test(declared)
      ? Array.from({ length: Math.min(16, Number(declared)) }, (_, i) => i + 1)
      : declared
          .split(',')
          .map((x) => Number(x.trim()))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 16);
  }
  if (!ports || ports.length === 0) {
    const seen = portsSeenReading();
    if (seen.length > 0) ports = seen;
  }
  if ((!ports || ports.length === 0) && ctx.uhf) {
    try {
      ports = await ctx.uhf.getAntennas();
    } catch {
      ports = null; // reader link down; try again on the next announce
    }
  }
  {
    if (Array.isArray(ports)) {
      for (const port of ports) {
        out.push({
          sourceKey: `${gate}:antenna:${port}`,
          type: 'antenna',
          name: `Antenna ${port}`,
          zoneName,
          ip: null,
          port: null,
          gateId: gate,
          antennaPort: port,
          frequencyMinutes: 5,
          checkNote: 'Confirms this antenna port is reading tags.',
        });
      }
    }
  }

  // Printers, but only the ones this bridge actually has.
  //
  // WHERE THE TRUTH LIVES. printer/index.js starts from DEFAULT_CONFIG - env
  // vars over HARDCODED PLACEHOLDERS ('Chainway CP30', 'Gprinter Test',
  // 192.168.99.201) - and then overlays data/printer.json, written whenever
  // someone configures the printer through POST /printer/config. So
  // printer.config at runtime always LOOKS populated, whether or not a printer
  // was ever set up.
  //
  // An earlier version of this used the env as the signal. That was wrong in
  // both directions: gate 1's printers are configured through the API and
  // persisted to the file (a TCP CP30 and a TSC T-4403E, neither of them the
  // placeholder name), so it would have announced nothing; and a gate with no
  // printer would still have matched on a stray var.
  //
  // The persisted file is the honest signal - it exists only where a printer has
  // actually been configured or used. Gate 2's data/ is empty, so it announces
  // no printer. Env is still accepted for a site configured that way instead.
  const pc = ctx.printer && ctx.printer.config ? ctx.printer.config : null;
  const persisted = persistedPrinterConfig();
  const hasCartonPrinter = Boolean(
    (persisted && persisted.printerName) || process.env.PRINTER_NAME || process.env.PRINTER_HOST
  );
  const hasPalletPrinter = Boolean(
    (persisted && persisted.palletPrinterName) ||
      process.env.PALLET_PRINTER_NAME ||
      process.env.PALLET_HOST
  );

  // SHARED, not per-gate. There is one RFID printer for the whole site, so a
  // gate-prefixed sourceKey would file the same physical printer twice — once
  // under Gate 1 and once under Gate 2 — and one paper jam would raise two
  // alarms about one machine. Worse, whoever is looking at Gate 2 would not see
  // the printer they actually use.
  //
  // So a printer gets a gate-independent key and lands in its own zone. Only the
  // bridge whose .env names the printer announces and checks it, which is also
  // the only bridge that can see its queue — a bridge with no view of the
  // spooler must not report on it (the same rule that stops a bare port knock
  // overwriting a reader's better verdict).
  //
  // Only the CARTON/RFID printer is shared. The site runs one Chainway RFID
  // printer for both gates, but each gate has its OWN pallet label printer on its
  // own PC — so only the carton row gets a gate-independent key and the shared
  // zone. Filing the pallet printers together would collapse two real machines
  // into one row and hide a fault on whichever lost the race.
  //
  // Site-wide kit goes in one zone that is not a gate. Named 'All' by default
  // because that is what it means to whoever is reading the board: applies to
  // all gates. CONTROL_TOWER_SHARED_ZONE renames it.
  const sharedZone =
    (process.env.CONTROL_TOWER_SHARED_ZONE || process.env.CONTROL_TOWER_PRINTER_ZONE || 'All').trim() ||
    'All';

  if (pc && hasCartonPrinter) {
    const tcp = pc.transport === 'tcp';
    out.push({
      sourceKey: 'shared:printer:carton',
      type: 'printer_rfid',
      name: pc.printerName || 'Carton Printer',
      zoneName: sharedZone,
      // A USB/spooler printer has no address at all, and saying so beats
      // inventing one.
      ip: tcp ? pc.host || null : null,
      port: tcp ? pc.port || null : null,
      frequencyMinutes: 15,
      checkNote: 'Checks the carton label/RFID printer is attached and accepting jobs.',
    });
  }

  if (pc && hasPalletPrinter) {
    const palletTcp = pc.palletTransport === 'tcp';
    out.push({
      sourceKey: `${gate}:printer:pallet`,
      type: 'printer_label',
      name: pc.palletPrinterName || 'Pallet Tag Printer',
      // This gate's own zone, not the shared one: every gate has its own pallet
      // printer, sitting on that gate's PC.
      zoneName,
      ip: palletTcp ? pc.palletHost || null : null,
      port: palletTcp ? pc.palletTcpPort || null : null,
      frequencyMinutes: 15,
      checkNote: 'Checks the pallet-tag printer is attached and accepting jobs.',
    });
  }

  // The routers this machine goes out through — one row each.
  //
  // A site can have more than one, and this one does: the warehouse runs on the
  // wired 192.168.1.x switch while the office WiFi is a separate 192.168.0.x
  // router. They fail independently and people notice them differently, so they
  // are separate rows rather than one 'network' light.
  //
  // Keyed 'shared:*' rather than per gate: both gates sit behind the same boxes,
  // so one cable pull should raise one alarm, not one per gate. Both bridges
  // announce the same keys, which is idempotent. Set CONTROL_TOWER_LAN_PER_GATE=1
  // if a site ever puts its gates on genuinely separate subnets.
  const perGate = /^(1|true|yes|on)$/i.test(process.env.CONTROL_TOWER_LAN_PER_GATE || '');
  const gateways = await defaultGateways();
  let wiredSeen = 0;
  let wirelessSeen = 0;
  for (const gw of gateways) {
    // The first of each kind keeps the plain key so existing rows are updated
    // rather than duplicated; a rare third router gets its address in the key.
    const nth = gw.wireless ? wirelessSeen++ : wiredSeen++;
    const kind = gw.wireless ? 'wifi' : 'lan';
    const suffix = nth === 0 ? '' : `:${gw.host}`;
    out.push({
      sourceKey: `${perGate ? gate : 'shared'}:${kind}${suffix}`,
      type: 'wifi',
      name: gw.wireless ? 'Office WiFi' : 'Local LAN',
      zoneName: perGate ? zoneName : sharedZone,
      ip: gw.host,
      port: null,
      frequencyMinutes: 5,
      checkNote: gw.wireless
        ? 'Pings the office WiFi router.'
        : 'Pings the router the warehouse network runs through.',
    });
  }

  return out;
}

/** 'gate-1' → 'Gate 1', so an announcement lands in the seeded zone. */
function prettyGate(id) {
  return String(id)
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// ── the outage buffer ───────────────────────────────────────────────────────

function readBuffer(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBuffer(path, results, log) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Bounded so a long outage can't grow the file without limit. Newest kept:
    // through a multi-day outage the recent picture matters more than its start.
    writeFileSync(path, JSON.stringify(results.slice(-5000)), 'utf8');
  } catch (err) {
    log(`could not write the buffer: ${err.message}`, 'error');
  }
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Start Control Tower reporting. Returns { stop() }.
 *
 * @param {object}  opts
 * @param {object} [opts.controller]  the bridge Controller (reader link state)
 * @param {object} [opts.uhf]         the uhf module (antenna link status)
 * @param {object} [opts.printer]     the PrinterManager (real printer readiness)
 * @param {string} [opts.readerIp]    where the reader is, for registration
 * @param {number} [opts.readerPort]
 * @param {string} [opts.gateId]      GATE_ID — which reader this bridge owns
 * @param {string} [opts.nexusUrl]    defaults to the ORIGIN of process.env.NEXUS_URL
 * @param {string} [opts.apiKey]      defaults to MOVEMENT_API_KEY / NEXUS_API_KEY
 * @param {string} [opts.agentName]   defaults to GATE_ID, else the hostname
 * @param {number} [opts.tickMs]
 * @param {string} [opts.bufferPath]
 * @param {(msg:string, level?:string)=>void} [opts.log]
 */
function startControlTower(opts) {
  const o = opts || {};
  const log = o.log || ((m, l) => console[l === 'error' ? 'error' : 'log'](`[control-tower] ${m}`));

  if (/^(0|off|false|no)$/i.test(process.env.CONTROL_TOWER || '')) {
    log('disabled by CONTROL_TOWER env');
    return { stop() {} };
  }

  // The bridge's NEXUS_URL is the FULL movement-ingest URL. The control-tower
  // endpoints live on the same deployment, so its origin is the base we want —
  // one variable to configure, not two that can drift apart.
  let base = (o.nexusUrl || '').replace(/\/$/, '');
  if (!base && process.env.NEXUS_URL) {
    try {
      base = new URL(process.env.NEXUS_URL).origin;
    } catch {
      base = '';
    }
  }
  const apiKey = (o.apiKey || process.env.MOVEMENT_API_KEY || process.env.NEXUS_API_KEY || '').trim();
  const gateId = (o.gateId || process.env.GATE_ID || '').trim() || null;
  const agentName = o.agentName || gateId || hostname() || 'bridge';
  const tickMs = Number(o.tickMs || process.env.CONTROL_TOWER_TICK_MS || DEFAULT_TICK_MS);
  const bufferPath =
    o.bufferPath || join(__dirname, '..', 'data', 'control-tower-pending.json');
  const ctx = {
    controller: o.controller || null,
    uhf: o.uhf || null,
    printer: o.printer || null,
    gateId,
    // Where the reader actually is. The live link wins over the configured
    // default — a reader moved to a new IP should register at the new one.
    readerIp: o.readerIp || null,
    readerPort: o.readerPort || null,
  };

  if (!base || !apiKey) {
    log('NEXUS_URL and MOVEMENT_API_KEY are required — not starting', 'warn');
    return { stop() {} };
  }

  /** When each device was last checked BY US, so per-device cadence is honoured. */
  const lastChecked = new Map();

  // Every tag read carries the port it arrived on. This is the antenna check.
  loadAntennaReads();
  if (o.controller && typeof o.controller.on === 'function') {
    o.controller.on('message', (msg) => {
      // Wrapped, and this matters more than it looks. This listener sits on the
      // live tag path: EventEmitter propagates a throwing listener straight out
      // of emit(), which is called from the controller's own tag handling. A bug
      // in MONITORING code must never be able to break carton ingestion, so the
      // worst case here is a lost antenna counter, not a lost read.
      try {
        if (msg && msg.type === 'tag' && msg.antenna != null) noteAntennaRead(msg.antenna);
      } catch {
        /* counting is best-effort; the gate comes first */
      }
    });
  } else {
    log('no controller passed — antennas can only be judged by tag traffic, which needs it', 'warn');
  }

  async function fetchWorkList() {
    const res = await fetch(`${base}/api/operations/control-tower/devices`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`work list: HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body.devices) ? body.devices : [];
  }

  /**
   * Tell Nexus what this bridge has. Runs at boot and on a slow timer — slow
   * because hardware changes at the speed of someone with a screwdriver, and an
   * announcement every tick would be pure noise.
   */
  async function announce() {
    let devices;
    try {
      devices = await discoverDevices(ctx);
    } catch (err) {
      log(`could not list local hardware: ${err.message}`, 'warn');
      return;
    }
    if (devices.length === 0) return;
    try {
      const res = await fetch(`${base}/api/operations/control-tower/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ agent: { name: agentName }, devices }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        log(`register: HTTP ${res.status}`, 'warn');
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (body.added || body.updated) {
        log(`registered ${body.added || 0} new, refreshed ${body.updated || 0} device(s)`);
      }
    } catch (err) {
      // Not buffered: the next announce re-derives the same list from live
      // config, so a missed one costs nothing.
      log(`register failed: ${err.message}`, 'warn');
    }
  }

  async function send(network, devices) {
    const res = await fetch(`${base}/api/operations/control-tower/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ agent: { name: agentName, version: VERSION }, network, devices }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 400) {
      // Won't get better on retry — drop it rather than wedge the buffer.
      log('report rejected as malformed; dropping this batch', 'error');
      return true;
    }
    return res.ok;
  }

  async function tick() {
    const network = await checkNetwork();

    let work;
    try {
      work = await fetchWorkList();
    } catch (err) {
      // Can't reach Nexus. Devices are still checkable, but without the list we
      // don't know what to check. The missing heartbeat is what tells Nexus
      // we're dark; buffered results go out when the link returns.
      log(err.message, 'warn');
      return;
    }

    const now = Date.now();
    const due = work.filter((d) => {
      if (d.checkRequestedAt) return true; // a human pressed "re-check"
      const last = lastChecked.get(d.id);
      return last === undefined || now - last >= (d.frequencyMinutes || 15) * 60000;
    });

    // Bounded concurrency: 40 devices shouldn't open 40 sockets at once, and one
    // stuck host must not hold up the rest of the pass.
    const results = [];
    const queue = due.slice();
    await Promise.all(
      Array.from({ length: Math.min(8, queue.length) }, async () => {
        while (queue.length > 0) {
          const device = queue.shift();
          if (!device) return;
          try {
            const r = await checkDevice(device, ctx);
            if (r) results.push(r); // null = another gate's device, not ours
          } catch (err) {
            log(`check failed for ${device.name}: ${err.message}`, 'error');
          }
          lastChecked.set(device.id, Date.now());
        }
      }),
    );

    const buffered = readBuffer(bufferPath);
    const outgoing = buffered.concat(results);

    // Always send, even with nothing due: the heartbeat is what distinguishes a
    // quiet warehouse from a dead bridge.
    let sent = false;
    try {
      sent = await send(network, outgoing);
    } catch {
      sent = false;
    }

    if (sent) {
      if (buffered.length > 0) {
        log(`backfilled ${buffered.length} buffered result(s)`);
        writeBuffer(bufferPath, [], log);
      }
      if (results.length > 0) log(`reported ${results.length} result(s)`);
    } else if (outgoing.length > 0) {
      writeBuffer(bufferPath, outgoing, log);
      log(`Nexus unreachable — buffered ${outgoing.length} result(s)`, 'warn');
    }
  }

  // A tick must never overlap itself: a slow pass on a stuck host would
  // otherwise stack up and duplicate work.
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      log(`tick failed: ${err.message}`, 'error');
    } finally {
      running = false;
    }
  };

  log(`${agentName} v${VERSION} → ${base} (every ${Math.round(tickMs / 1000)}s)`);
  if (!ctx.uhf) log('no uhf module passed — antenna rows will report Unchecked', 'warn');

  // Boot self-check. Whoever installs this needs to know immediately whether it
  // can see the network it is meant to be reporting on — a wrong service account
  // or a machine with no WiFi radio shows up here, not as a week of nulls.
  void checkNetwork().then((boot) => {
    log(
      `link: ${boot.link.type}${boot.link.ssid ? ` "${boot.link.ssid}"` : ''}` +
        `${boot.link.rssiDbm != null ? ` ${boot.link.rssiDbm}dBm` : ''}` +
        `${boot.link.linkSpeedMbps != null ? ` ${boot.link.linkSpeedMbps}Mbps` : ''}` +
        ` · gateway ${boot.gateway.host || '?'} ${boot.gateway.reachable ? 'OK' : 'UNREACHABLE'}` +
        ` · dns ${boot.dns.ok ? 'OK' : 'FAIL'} · internet ${boot.internet.ok ? 'OK' : 'FAIL'}`,
    );
  });

  // Announce first so the very first check pass has rows to check. The reader
  // link may not be up yet at boot, so antennas can be missing from this one —
  // the periodic re-announce catches them.
  void announce().then(() => run());
  const timer = setInterval(() => void run(), tickMs);
  const announceTimer = setInterval(() => void announce(), ANNOUNCE_MS);
  // Throttled: the antenna read counters change on every tag, the file does not
  // need to. Flushed again on stop so a clean shutdown loses nothing.
  const saveTimer = setInterval(() => saveAntennaReads(log), 60_000);
  return {
    stop() {
      clearInterval(timer);
      clearInterval(announceTimer);
      clearInterval(saveTimer);
      saveAntennaReads(log);
    },
  };
}

module.exports = { startControlTower, checkNetwork, checkDevice, discoverDevices, tcpConnect, ping };
