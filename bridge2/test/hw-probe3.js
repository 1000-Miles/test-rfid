'use strict';

/**
 * Probe 3: vendor-faithful UDP receive path — BindUDP (DLL-side socket) +
 * UHF_GetReceived_EX drain, exactly like the vendor's ReceiveEPC.cs.
 *
 * Phase A: work mode 1 (AUTO)    — TAG ON ANTENNA, no beam needed.
 * Phase B: work mode 2 (TRIGGER) — BREAK THE IR BEAM, tag still on antenna.
 * Also keeps a plain Node dgram socket on a second port OFF — DLL owns the port.
 * Restores work mode 0 at the end.
 *
 * Usage: node test/hw-probe3.js [ip] [port] [udpPort]
 */

const os = require('os');
const uhf = require('../src/uhf');

const ip = process.argv[2] || '192.168.99.202';
const port = parseInt(process.argv[3] || '8888', 10);
const udpPort = parseInt(process.argv[4] || '9090', 10);

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

async function drain(seconds, label) {
  let n = 0;
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const tag = uhf.pollTag();
    if (tag) {
      n++;
      log(`${label} TAG epc=${tag.epc} ant=${tag.antenna} rssi=${tag.rssi} raw=${tag.raw}`);
    } else {
      await sleep(10);
    }
  }
  return n;
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

  const rcDest = uhf.setDestIp(host, udpPort);
  log(`setDestIp(${host},${udpPort}) rc=${rcDest} readback=${JSON.stringify(uhf.getDestIp())}`);

  const rcBind = uhf.bindUdp(udpPort);
  log(`BindUDP(${udpPort}) rc=${rcBind}`);

  // ---- Phase A: AUTO --------------------------------------------------------
  let rcMode = uhf.setWorkMode(1);
  log(`workMode(1 AUTO) rc=${rcMode} readback=${uhf.getWorkMode()}`);
  log('PHASE A (25s): AUTO — tag on antenna.');
  const a = await drain(25, 'A');
  log(`PHASE A done: ${a} tags.`);

  // ---- Phase B: TRIGGER -----------------------------------------------------
  const rcPara = uhf.setWorkModePara(0, 1000, 200, 1);
  rcMode = uhf.setWorkMode(2);
  log(`workModePara rc=${rcPara}, workMode(2 TRIGGER) rc=${rcMode} readback=${uhf.getWorkMode()}`);
  log('PHASE B (60s): TRIGGER — BREAK THE IR BEAM repeatedly.');
  const b = await drain(60, 'B');
  log(`PHASE B done: ${b} tags.`);

  uhf.setWorkMode(0);
  uhf.unbindUdp();
  uhf.disconnect();

  log('VERDICT:');
  if (a > 0 && b > 0) log('  Both flow — DONE. Bridge switches to BindUDP path; HW mode works.');
  else if (a > 0) log('  AUTO works via BindUDP, TRIGGER silent => IR sensor/GPI wiring fault.');
  else log('  Still nothing even in AUTO via BindUDP => reader not reading (tag? power?) or not pushing (firmware).');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try {
    uhf.setWorkMode(0);
    uhf.unbindUdp();
    uhf.disconnect();
  } catch (_) {}
  process.exit(99);
});
