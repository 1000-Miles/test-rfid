'use strict';

/**
 * Probe 5: does trigger/auto work mode only ARM AFTER A POWER CYCLE?
 *
 * 1. Configure over TCP: destIp -> laptop:9090, trigger params (GPI1, 1s
 *    burst, UDP output), work mode 2. Disconnect.
 * 2. USER: POWER-CYCLE THE READER (unplug 5s, replug). Script waits 45s.
 * 3. BindUDP + drain 60s — USER BREAKS THE IR BEAM (tag on antenna).
 * 4. Reconnect TCP, watch GPI via UHFGetIOControl (UR4 path) 30s — USER
 *    BREAKS THE BEAM AGAIN. Prints every change.
 *
 * Leaves the reader in work mode 2 (armed).
 *
 * Usage: node test/hw-probe5.js [ip] [port] [udpPort]
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

async function main() {
  uhf.load();
  uhf.setLogLevel(0);
  const host = hostIpForReader(ip);

  // ---- 1: configure + arm ----------------------------------------------------
  const rc = uhf.connect(ip, port);
  if (rc !== 0) {
    log(`TCPConnect -> ${rc}.`);
    process.exit(1);
  }
  log(`Connected. power=${uhf.getPower()}dBm`);
  log(`setDestIp rc=${uhf.setDestIp(host, udpPort)} readback=${JSON.stringify(uhf.getDestIp())}`);
  log(`workModePara rc=${uhf.setWorkModePara(0, 1000, 200, 1)} readback=${JSON.stringify(uhf.getWorkModePara())}`);
  log(`workMode(2) rc=${uhf.setWorkMode(2)} readback=${uhf.getWorkMode()}`);
  uhf.disconnect();
  log('Configured & disconnected.');

  // ---- 2: power cycle ---------------------------------------------------------
  log('');
  log('>>> POWER-CYCLE THE READER NOW: unplug power, wait 5s, plug back in. <<<');
  log('    Waiting 45s for reboot...');
  await sleep(45000);

  // ---- 3: UDP listen ----------------------------------------------------------
  log(`BindUDP(${udpPort}) rc=${uhf.bindUdp(udpPort)}`);
  log('PHASE UDP (60s): BREAK THE IR BEAM repeatedly, tag on antenna.');
  let tags = 0;
  let deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const tag = uhf.pollTag();
    if (tag) {
      tags++;
      log(`TAG epc=${tag.epc} ant=${tag.antenna} rssi=${tag.rssi} raw=${tag.raw}`);
    } else {
      await sleep(10);
    }
  }
  uhf.unbindUdp();
  log(`PHASE UDP done: ${tags} tags.`);

  // ---- 4: GPI watch (UR4 = UHFGetIOControl) ----------------------------------
  let rcc = -1;
  for (let i = 0; i < 15 && rcc !== 0; i++) {
    rcc = uhf.connect(ip, port);
    if (rcc !== 0) await sleep(2000);
  }
  if (rcc !== 0) {
    log('Could not reconnect TCP for GPI watch.');
  } else {
    log('PHASE GPI (30s): BREAK THE BEAM — watching UHFGetIOControl (UR4 GPI).');
    let prev = '';
    deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const g = uhf.getGpi();
      const key = `${g.raw}|${g.gpi1}|${g.gpi2}`;
      if (key !== prev) {
        log(`GPI raw=${g.raw} gpi1=${g.gpi1} gpi2=${g.gpi2}${prev ? '  <<< CHANGED' : ''}`);
        prev = key;
      }
      await sleep(120);
    }
    uhf.disconnect();
  }

  log('VERDICT:');
  if (tags > 0) log('  UDP flows after power cycle — work mode arms at boot. Bridge must document/automate this.');
  else log('  Still no UDP after power cycle. GPI phase above shows whether the beam registers at all now.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try {
    uhf.unbindUdp();
    uhf.disconnect();
  } catch (_) {}
  process.exit(99);
});
