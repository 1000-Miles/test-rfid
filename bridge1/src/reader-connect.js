'use strict';

/**
 * Finding and opening a desktop UHF reader, with a liveness check.
 *
 * Split out of the CLI scripts because every one of them needs the same thing:
 * open SOMETHING, and be certain a reader is really on the other end before
 * touching a tag. See uhf.isReaderAlive for why the SDK's return code is not
 * enough — UsbOpen() reports success against an empty USB bus, and the first
 * tag operation after that takes the process down with it.
 */

const { execFileSync } = require('child_process');
const uhf = require('./uhf');

/** COM ports Windows currently knows about, e.g. [1, 3]. */
function listComPorts() {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return [...out.matchAll(/COM(\d+)\s*$/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
  } catch (_) {
    return []; // no serial ports registered, or not Windows
  }
}

/**
 * Open one transport and confirm a reader answers. Closes the link again if it
 * turns out to be a phantom, so the caller can keep trying other transports.
 * @returns {{ok:boolean, rc:number|null, reason:string}}
 */
function openAndVerify(open) {
  let rc;
  try {
    rc = open();
  } catch (err) {
    return { ok: false, rc: null, reason: `threw: ${err.message}` };
  }
  if (rc !== 0) return { ok: false, rc, reason: `rc=${rc}` };
  if (!uhf.isReaderAlive()) {
    uhf.disconnect();
    return { ok: false, rc, reason: 'rc=0 but no reader answered (phantom link)' };
  }
  return { ok: true, rc, reason: 'reader answered' };
}

/**
 * Try transports until a reader answers.
 * @param {object} [opts]
 * @param {string} [opts.tcp]   'ip:port' — use TCP only
 * @param {number} [opts.com]   COM number — use that port only
 * @param {number} [opts.baud]  with opts.com
 * @param {boolean} [opts.usbOnly]  skip the COM sweep
 * @param {(line:string)=>void} [opts.onAttempt]  progress callback
 * @returns {{ok:boolean, transport:(string|null)}}
 */
function autoConnect(opts = {}) {
  const note = opts.onAttempt || (() => {});
  const attempt = (label, open) => {
    const r = openAndVerify(open);
    note(`${label.padEnd(18)}${r.ok ? 'OPEN — reader answered' : r.reason}`);
    return r.ok;
  };

  if (opts.tcp) {
    const [ip, port] = String(opts.tcp).split(':');
    return { ok: attempt(`tcp ${opts.tcp}`, () => uhf.connect(ip, Number(port || 8888))), transport: 'tcp' };
  }

  if (opts.com != null) {
    const label = `COM${opts.com}${opts.baud ? ` @${opts.baud}` : ''}`;
    return { ok: attempt(label, () => uhf.connectCom(Number(opts.com), opts.baud ?? null)), transport: 'com' };
  }

  if (attempt('UsbOpen()', () => uhf.connectUsb())) return { ok: true, transport: 'usb' };
  if (opts.usbOnly) return { ok: false, transport: null };

  const ports = listComPorts();
  if (!ports.length) note('(no COM ports registered on this machine)');
  for (const p of ports) {
    if (attempt(`ComOpen(${p})`, () => uhf.connectCom(p))) return { ok: true, transport: 'com' };
  }
  return { ok: false, transport: null };
}

/** Standard "we couldn't find it" advice, shared by every CLI script. */
const NO_READER_HELP = [
  'No reader answered on any transport. Either it is unplugged/powered off, or',
  'this UHFAPI.dll (the UR4/UR1A Windows build) does not drive it and we need',
  "Chainway's R-series SDK instead.",
  '',
  'Check Windows sees it:  Get-PnpDevice -PresentOnly -Class USB,Ports,HIDClass',
].join('\n');

module.exports = { listComPorts, openAndVerify, autoConnect, NO_READER_HELP };
