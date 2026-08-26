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
    const out = (err && err.stdout) || '';
    if (out) {
      const ok = /ttl[=\s]/i.test(out);
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
  if (!ctx.uhf) return unknown('This bridge build has no reader module wired.');

  // Belt and braces: checkDevice already filters foreign gates via
  // belongsToAnotherGate. Kept so calling checkAntenna directly is still safe.
  if (device.gateId && ctx.gateId && device.gateId !== ctx.gateId) return null;

  let connectedPorts = null;
  let power = null;
  try {
    connectedPorts = await ctx.uhf.getAntennaLink();
    // Power is a nicety; never let it fail the check.
    try {
      power = await ctx.uhf.getAntennaPower();
    } catch {
      power = null;
    }
  } catch (err) {
    // requireLink threw: the reader link is down. The antenna's state is
    // genuinely unknowable right now, and the reader row will say so itself.
    return unknown(`Reader link is down, so its antenna ports can't be read (${err.message}).`);
  }

  if (!Array.isArray(connectedPorts)) {
    return unknown('The reader would not report antenna link status.');
  }

  const port = Number(device.antennaPort);
  if (!connectedPorts.includes(port)) {
    return {
      status: 'offline',
      issue: OFFLINE_HINT.antenna,
      detail:
        `Reader reports port ${port} as not connected` +
        (connectedPorts.length ? ` (connected: ${connectedPorts.join(', ')}).` : ' (no ports connected).'),
      latencyMs: null,
    };
  }

  // Connected — but an ENABLED check is worth making too: a physically attached
  // antenna on a disabled port reads nothing, and looks fine to every other test.
  let enabled = null;
  try {
    enabled = await ctx.uhf.getAntennas();
  } catch {
    enabled = null;
  }
  if (Array.isArray(enabled) && !enabled.includes(port)) {
    return {
      status: 'warning',
      issue: `Antenna is connected but port ${port} is disabled on the reader.`,
      detail: `Enabled ports: ${enabled.join(', ') || 'none'}.`,
      latencyMs: null,
    };
  }

  const dBm = power && power[port] ? power[port].read : null;
  return {
    status: 'online',
    issue: null,
    detail: `Reader reports port ${port} connected${dBm != null ? ` at ${dBm} dBm` : ''}.`,
    latencyMs: null,
  };
}

/**
 * Printers, asked through the PrinterManager rather than knocked on.
 *
 * This is a much better answer than a TCP connect. The Windows spooler accepts
 * jobs with no printer attached, so port 9100 answering proves almost nothing —
 * checkReady() is the verdict the print path itself gates on.
 */
async function checkPrinter(device, ctx) {
  if (!ctx.printer) return null;
  // Which printer this row IS decides which readiness check answers for it. The
  // two are different devices with different queues, so running the carton check
  // against the pallet printer would report an out-of-media Gprinter as healthy.
  // sourceKey comes back on the work list precisely so this can be told apart;
  // without one (a hand-added row) fall back to the name.
  const key = device.sourceKey || '';
  const isPallet = key
    ? key.endsWith(':printer:pallet')
    : device.type === 'printer_label';
  try {
    const r = isPallet ? await ctx.printer.checkPalletReady() : await ctx.printer.checkReady();
    if (!r || typeof r.ready !== 'boolean') return null;
    return r.ready
      ? { status: 'online', issue: null, detail: r.detail || 'Printer ready.', latencyMs: null }
      : {
          status: 'offline',
          issue: OFFLINE_HINT[device.type] || 'Printer not ready.',
          detail: r.detail || 'Printer reported not ready.',
          latencyMs: null,
        };
  } catch {
    return null; // fall through to the plain network check
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
  if (ctx.controller.reading === false) {
    return {
      status: 'warning',
      issue: 'Reader is connected but not reading.',
      detail: 'Link is open, inventory is stopped.',
      latencyMs: null,
    };
  }
  return { status: 'online', issue: null, detail: 'Reader link open and reading.', latencyMs: null };
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

async function checkDevice(device, ctx) {
  const at = new Date().toISOString();
  const wrap = (r) => (r ? Object.assign({ id: device.id, at }, r) : null);

  // Not ours to answer for. Returning null sends nothing at all for this row.
  if (belongsToAnotherGate(device, ctx)) return null;

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

/** The default gateway — 'the router', and what separates two different outages. */
async function defaultGateway() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop",
        ],
        { timeout: 10000 },
      );
      return stdout.trim() || null;
    }
    const { stdout } = await execFileAsync('sh', ['-c', "ip route | awk '/default/ {print $3; exit}'"], {
      timeout: 8000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
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

// ── self-registration ───────────────────────────────────────────────────────

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
  const zoneName = prettyGate(gate);
  const out = [];

  // The bridge itself. No address: the check is that this code is running.
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
  if (ctx.uhf) {
    let ports = null;
    try {
      ports = await ctx.uhf.getAntennas();
    } catch {
      ports = null; // reader link down; try again on the next announce
    }
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
          checkNote: 'Asks the reader whether an antenna is physically connected on this port.',
        });
      }
    }
  }

  // Printers, but ONLY where this gate's .env actually names one.
  //
  // printer/index.js gives printerName and palletPrinterName hardcoded fallbacks
  // ('Chainway CP30', 'Gprinter Test'), so printer.config always LOOKS like a
  // printer is configured. Trusting it registers two printers on a gate that has
  // none — gate 2 being exactly that case — and they then sit permanently
  // offline. A device that was never there is not a fault; inventing one is the
  // same lie as a fabricated green light, pointed the other way.
  //
  // So the env is the source of truth for "this gate HAS a printer", and the
  // config is only asked WHERE it is.
  const pc = ctx.printer && ctx.printer.config ? ctx.printer.config : null;
  const hasCartonPrinter = Boolean(
    process.env.PRINTER_NAME || process.env.PRINTER_HOST || process.env.PRINTER_TRANSPORT
  );
  const hasPalletPrinter = Boolean(process.env.PALLET_PRINTER_NAME || process.env.PALLET_HOST);

  if (pc && hasCartonPrinter) {
    const tcp = pc.transport === 'tcp';
    out.push({
      sourceKey: `${gate}:printer:carton`,
      type: 'printer_rfid',
      name: pc.printerName || 'Carton Printer',
      zoneName,
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
      zoneName,
      ip: palletTcp ? pc.palletHost || null : null,
      port: palletTcp ? pc.palletTcpPort || null : null,
      frequencyMinutes: 15,
      checkNote: 'Checks the pallet-tag printer is attached and accepting jobs.',
    });
  }

  // The router, OPT-IN.
  //
  // Off by default for two reasons: the dashboard's connection card already
  // reports each bridge's router from the heartbeat, and with two gates behind
  // one router this registers the same physical box twice, in two zones, where
  // one cable pull would raise two alarms about one fault.
  //
  // Worth switching on where a gate has its own router or AP that is genuinely
  // separate hardware: CONTROL_TOWER_ANNOUNCE_ROUTER=1.
  if (/^(1|true|yes|on)$/i.test(process.env.CONTROL_TOWER_ANNOUNCE_ROUTER || '')) {
    const gw = await defaultGateway();
    if (gw) {
      out.push({
        sourceKey: `${gate}:gateway`,
        type: 'wifi',
        name: 'Network Router',
        zoneName,
        ip: gw,
        port: null,
        frequencyMinutes: 5,
        checkNote: 'Pings the default gateway this bridge reaches the network through.',
      });
    }
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
  return {
    stop() {
      clearInterval(timer);
      clearInterval(announceTimer);
    },
  };
}

module.exports = { startControlTower, checkNetwork, checkDevice, discoverDevices, tcpConnect, ping };
