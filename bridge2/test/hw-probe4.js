'use strict';

/**
 * Probe 4: BindUDP is a LINK, not a side-channel — it must not coexist with
 * the TCP command link (probe 3 showed TCP commands fail after BindUDP).
 *
 * Sequence per phase: TCPConnect -> configure -> TCPDisconnect -> BindUDP ->
 * drain UHF_GetReceived_EX -> UnbindUDP.
 *
 * Phase A: work mode 1 (AUTO)    — TAG ON ANTENNA.
 * Phase B: work mode 2 (TRIGGER) — BREAK THE IR BEAM, tag on antenna.
 * Restores work mode 0 at the end.
 *
 * Usage: node test/hw-probe4.js [ip] [port] [udpPort]
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

function tcpConfig(label, fn) {
  const rc = uhf.connect(ip, port);
  if (rc !== 0) throw new Error(`${label}: TCPConnect -> ${rc}`);
  try {
    fn();
  } finally {
    uhf.disconnect();
  }
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
  log(`host=${host}`);

  // ---- Phase A: AUTO --------------------------------------------------------
  tcpConfig('phaseA', () => {
    log(`setDestIp rc=${uhf.setDestIp(host, udpPort)} readback=${JSON.stringify(uhf.getDestIp())}`);
    log(`workMode(1 AUTO) rc=${uhf.setWorkMode(1)} readback=${uhf.getWorkMode()}`);
  });
  log(`TCP closed. BindUDP(${udpPort}) rc=${uhf.bindUdp(udpPort)}`);
  log('PHASE A (25s): AUTO — tag on antenna.');
  const a = await drain(25, 'A');
  uhf.unbindUdp();
  log(`PHASE A done: ${a} tags. UnbindUDP'd.`);

  // ---- Phase B: TRIGGER -----------------------------------------------------
  tcpConfig('phaseB', () => {
    log(`workModePara rc=${uhf.setWorkModePara(0, 1000, 200, 1)}`);
    log(`workMode(2 TRIGGER) rc=${uhf.setWorkMode(2)} readback=${uhf.getWorkMode()}`);
  });
  log(`TCP closed. BindUDP(${udpPort}) rc=${uhf.bindUdp(udpPort)}`);
  log('PHASE B (60s): TRIGGER — BREAK THE IR BEAM repeatedly.');
  const b = await drain(60, 'B');
  uhf.unbindUdp();
  log(`PHASE B done: ${b} tags. UnbindUDP'd.`);

  // ---- restore ----------------------------------------------------------------
  tcpConfig('restore', () => {
    log(`workMode(0) rc=${uhf.setWorkMode(0)}`);
  });

  log('VERDICT:');
  if (a > 0 && b > 0) log('  Both flow — DONE. Bridge hw mode: config over TCP, then BindUDP + drain.');
  else if (a > 0) log('  AUTO works, TRIGGER silent => IR sensor/GPI wiring fault (reader never sees beam).');
  else log('  AUTO still silent => reader not reading in auto mode (tag present? power?) or UDP push needs something else.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try {
    uhf.unbindUdp();
    uhf.connect(ip, port);
    uhf.setWorkMode(0);
    uhf.disconnect();
  } catch (_) {}
  process.exit(99);
});
