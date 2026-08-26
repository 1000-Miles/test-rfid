'use strict';

/**
 * Isolation probe for HW UDP output.
 *
 * Phase A: work mode 1 (AUTO) — reader inventories continuously and pushes
 *          UDP with no trigger involved. PUT A TAG ON THE ANTENNA.
 *          Datagrams here prove the whole UDP path + reveal the frame format.
 * Phase B: work mode 2 (TRIGGER) — BREAK THE IR BEAM (tag still on antenna).
 *          Silence here while Phase A worked = IR sensor/GPI wiring fault.
 *
 * Listens on 8995 (0x2323, endian-proof) AND 9090 simultaneously.
 * Restores work mode 0 at the end.
 *
 * Usage: node test/hw-probe2.js [ip] [port]
 */

const os = require('os');
const dgram = require('dgram');
const uhf = require('../src/uhf');

const ip = process.argv[2] || '192.168.99.202';
const port = parseInt(process.argv[3] || '8888', 10);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
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

const counters = { 8995: 0, 9090: 0 };

function bindSock(udpPort) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf, rinfo) => {
    counters[udpPort]++;
    let parsed = null;
    try {
      parsed = uhf.parseUdpDatagram(buf);
    } catch (_) {}
    log(
      `UDP:${udpPort} <<< ${rinfo.address}:${rinfo.port} len=${buf.length} raw=${buf.toString('hex').toUpperCase()}` +
        (parsed ? ` PARSED epc=${parsed.epc} rssi=${parsed.rssi}` : '')
    );
  });
  sock.on('error', (e) => log(`UDP:${udpPort} error ${e.message}`));
  sock.bind(udpPort, () => log(`bound UDP :${udpPort}`));
  return sock;
}

async function main() {
  uhf.load();
  uhf.setLogLevel(0);
  const host = hostIpForReader(ip);
  const rc = uhf.connect(ip, port);
  if (rc !== 0) {
    log(`TCPConnect -> ${rc}. Reader busy/unreachable.`);
    process.exit(1);
  }
  log(`Connected. host=${host}`);

  const s1 = bindSock(8995);
  const s2 = bindSock(9090);

  // ---- Phase A: AUTO mode, no trigger needed --------------------------------
  let rcDest = uhf.setDestIp(host, 8995);
  log(`setDestIp(${host},8995) rc=${rcDest} readback=${JSON.stringify(uhf.getDestIp())}`);
  let rcMode = uhf.setWorkMode(1);
  log(`workMode(1 AUTO) rc=${rcMode} readback=${uhf.getWorkMode()}`);
  log('PHASE A (25s): AUTO mode — tag on antenna, no beam needed.');
  await sleep(25000);
  const aFrames = counters[8995] + counters[9090];
  log(`PHASE A done: ${counters[8995]} frames on 8995, ${counters[9090]} on 9090.`);

  // ---- Phase B: TRIGGER mode -------------------------------------------------
  const rcPara = uhf.setWorkModePara(0, 1000, 200, 1); // GPI1, 1s burst, UDP
  rcMode = uhf.setWorkMode(2);
  log(`workModePara rc=${rcPara}, workMode(2 TRIGGER) rc=${rcMode} readback=${uhf.getWorkMode()}`);
  log('PHASE B (60s): TRIGGER mode — BREAK THE IR BEAM repeatedly, tag on antenna.');
  const before = counters[8995] + counters[9090];
  await sleep(60000);
  const bFrames = counters[8995] + counters[9090] - before;
  log(`PHASE B done: ${bFrames} new frames.`);

  uhf.setWorkMode(0);
  uhf.disconnect();
  s1.close();
  s2.close();

  log('VERDICT:');
  if (aFrames > 0 && bFrames > 0) log('  Both phases flow — everything works. Restart bridge, use HW mode.');
  else if (aFrames > 0) log('  AUTO works, TRIGGER silent => IR sensor / GPI wiring fault (reader never sees the beam).');
  else log('  Even AUTO mode sent nothing => UDP output path broken upstream of the trigger (tag present? firewall? UDP feature unsupported on this firmware).');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try {
    uhf.setWorkMode(0);
    uhf.disconnect();
  } catch (_) {}
  process.exit(99);
});
