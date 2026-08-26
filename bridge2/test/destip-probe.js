'use strict';

/**
 * Hardware probe for HW trigger mode (work mode 2 + UDP output).
 *
 * Verifies on the real reader:
 *   1. UHFSetDestIp binary encoding (4 ip octets + 2 port bytes) is stored
 *      correctly (readback must match).
 *   2. Datagrams actually arrive when the IR beam breaks.
 *      Phase 1 uses port 8995 (0x2323 — same bytes big- or little-endian, so
 *      it works regardless of the reader's port byte order).
 *      Phase 2 uses port 9090 (0x2382 big-endian) — if datagrams arrive there
 *      too, big-endian is confirmed and the bridge default is safe.
 *
 * BREAK THE IR BEAM several times during each phase.
 *
 * Usage: node test/destip-probe.js [ip] [port]
 */

const os = require('os');
const dgram = require('dgram');
const uhf = require('../src/uhf');

const ip = process.argv[2] || '192.168.99.202';
const port = parseInt(process.argv[3] || '8888', 10);

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(`[${ts()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hostIpForReader(readerIp) {
  const prefix = readerIp.split('.').slice(0, 3).join('.') + '.';
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix)) return a.address;
    }
  }
  return null;
}

function listenPhase(udpPort, seconds) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const frames = [];
    sock.on('message', (buf, rinfo) => {
      const raw = buf.toString('hex').toUpperCase();
      let parsed = null;
      try {
        parsed = uhf.parseUdpDatagram(buf);
      } catch (_) {}
      frames.push(raw);
      log(`UDP <<< ${rinfo.address}:${rinfo.port} len=${buf.length} raw=${raw}` + (parsed ? ` PARSED epc=${parsed.epc} rssi=${parsed.rssi} ant=${parsed.antenna}` : ' (unparsed)'));
    });
    sock.on('error', (e) => log(`UDP socket error: ${e.message}`));
    sock.bind(udpPort, () => log(`Listening on UDP 0.0.0.0:${udpPort} for ${seconds}s — BREAK THE IR BEAM NOW.`));

    // Poll GPI so we can see beam edges even if no UDP arrives.
    let lastGpi1 = null;
    const gpiTimer = setInterval(() => {
      try {
        const g = uhf.getGpi();
        if (g.gpi1 !== lastGpi1) {
          log(`GPI edge: gpi1=${g.gpi1} gpi2=${g.gpi2} raw=${g.raw}`);
          lastGpi1 = g.gpi1;
        }
      } catch (_) {}
    }, 200);

    setTimeout(() => {
      clearInterval(gpiTimer);
      sock.close();
      resolve(frames.length);
    }, seconds * 1000);
  });
}

async function main() {
  uhf.load();
  uhf.setLogLevel(0);

  const host = hostIpForReader(ip);
  log(`Reader ${ip}:${port}, host NIC on subnet: ${host}`);
  if (!host) {
    log('FAIL: no local IPv4 on the reader subnet.');
    process.exit(1);
  }

  const rc = uhf.connect(ip, port);
  if (rc !== 0) {
    log(`FAIL: TCPConnect -> ${rc}. Is the bridge still connected? POST /disconnect first.`);
    process.exit(1);
  }
  log('Connected.');

  log('destIp BEFORE:', JSON.stringify(uhf.getDestIp()));

  // ---- Phase 1: endianness-proof port 8995 (0x2323) -------------------------
  let rcDest = uhf.setDestIp(host, 8995);
  let back = uhf.getDestIp();
  log(`setDestIp(${host}, 8995) rc=${rcDest}, readback: ${JSON.stringify(back)}`);
  if (!back || back.ip !== host) {
    log('FAIL: readback ip mismatch — binary encoding still wrong. Raw bytes above are the clue.');
    uhf.setWorkMode(0);
    uhf.disconnect();
    process.exit(2);
  }

  const rcPara = uhf.setWorkModePara(0, 500, 200, 1); // GPI1, 500ms, 200ms gap, UDP
  const rcMode = uhf.setWorkMode(2);
  log(`workModePara rc=${rcPara}, workMode(2) rc=${rcMode}, para readback: ${JSON.stringify(uhf.getWorkModePara())}`);

  const got1 = await listenPhase(8995, 40);
  log(`Phase 1 (port 8995): ${got1} datagrams.`);

  if (got1 === 0) {
    log('No datagrams on the endian-proof port. Beam edges above tell whether the trigger fired at all.');
    log('If GPI edges appeared but no UDP: check Windows Firewall inbound UDP for node.exe.');
    uhf.setWorkMode(0);
    uhf.disconnect();
    process.exit(3);
  }

  // ---- Phase 2: confirm big-endian port encoding with 9090 ------------------
  rcDest = uhf.setDestIp(host, 9090);
  back = uhf.getDestIp();
  log(`setDestIp(${host}, 9090) rc=${rcDest}, readback: ${JSON.stringify(back)} (raw port should be 2382)`);

  const got2 = await listenPhase(9090, 30);
  log(`Phase 2 (port 9090): ${got2} datagrams.`);
  log(got2 > 0 ? 'BIG-ENDIAN CONFIRMED — bridge default port encoding is correct.' : 'Port 9090 silent — port bytes may be little-endian; retry bridge with udpPort 8995 or swap byte order.');

  uhf.setWorkMode(0);
  uhf.disconnect();
  log('Restored work mode 0 and disconnected. Restart the bridge and reconnect from the dashboard.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled:', err);
  try {
    uhf.setWorkMode(0);
    uhf.disconnect();
  } catch (_) {}
  process.exit(99);
});
