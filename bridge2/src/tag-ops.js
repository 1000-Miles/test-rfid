'use strict';

/**
 * Tag-level operations shared by the CLI tools: singulation with a
 * one-tag-only guard, TID decoding, and EPC-bank capacity probing.
 *
 * The one-tag guard is the safety story for encoding. The usual way to ruin a
 * batch of tags is to write while a neighbour is in the field and silently
 * reprogram the wrong chip; low power reduces the odds but does not remove
 * them. So: refuse to act unless exactly one tag answers, and address every
 * write with a TID filter so even a late arrival cannot be the one that gets
 * written.
 */

const uhf = require('./uhf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sweep the field and return every distinct tag seen.
 * @param {number} ms  how long to inventory for
 * @returns {Promise<Array<{epc:string, pc:string|null, reads:number, rssi:number|null}>>}
 */
async function scanField(ms = 600) {
  const rc = uhf.startInventory();
  if (rc !== 0) throw new Error(`UHFInventory() failed with rc=${rc}`);
  const byEpc = new Map();
  try {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const tag = uhf.pollTag();
      if (!tag || !tag.epc) {
        await sleep(5);
        continue;
      }
      const prev = byEpc.get(tag.epc);
      if (prev) {
        prev.reads++;
        if (tag.rssi != null && (prev.rssi == null || tag.rssi > prev.rssi)) prev.rssi = tag.rssi;
      } else {
        byEpc.set(tag.epc, { epc: tag.epc, pc: tag.pc ?? null, reads: 1, rssi: tag.rssi ?? null });
      }
    }
  } finally {
    uhf.stopInventory();
  }
  return [...byEpc.values()].sort((a, b) => b.reads - a.reads);
}

/**
 * Require exactly one tag in the field, and return it.
 * Throws — with the offending EPCs listed — on zero or several, because both
 * are operator errors that must stop a batch rather than be worked around.
 */
async function requireSingleTag(ms = 600) {
  const found = await scanField(ms);
  if (found.length === 0) throw new Error('no tag in the field — place ONE tag on the reader');
  if (found.length > 1) {
    const list = found.map((t) => `${t.epc} (${t.reads} reads, ${t.rssi ?? '?'}dBm)`).join('\n    ');
    throw new Error(`${found.length} tags in the field — encode ONE at a time. Saw:\n    ${list}`);
  }
  return found[0];
}

// --- TID decoding ----------------------------------------------------------

/**
 * Mask-designer IDs we can name with confidence. Anything else is reported as
 * unknown rather than guessed at — the authoritative list is GS1's MDID
 * registry, and a wrong vendor name here would be worse than no name.
 */
const MDID_VENDORS = {
  0x001: 'Impinj',
  0x003: 'Alien Technology',
  0x004: 'Atmel',
  0x006: 'NXP Semiconductors',
  0x007: 'EM Microelectronic',
};

const ALLOCATION_CLASS = {
  0xe0: 'ISO/IEC 15963 (non-EPC)',
  0xe2: 'EPCglobal Gen2',
  0xe3: 'ISO/IEC 15963 (non-EPC)',
};

/**
 * Decode a TID read from bank 2.
 *
 * For allocation class E2 the layout is:
 *   bits 00h-07h  allocation class identifier (E2)
 *   bits 08h-13h  12-bit mask-designer ID; its MSB is the XTID indicator
 *   bits 14h-1Fh  12-bit tag model number
 *   bits 20h+     serial (present when XTID is set)
 *
 * @param {string} hex  TID bytes as hex
 * @returns {object} decoded fields; `vendor` is null when the MDID is one we
 *   cannot name, which is a real answer and not a failure.
 */
function decodeTid(hex) {
  const buf = Buffer.from(String(hex).replace(/[^0-9a-fA-F]/g, ''), 'hex');
  if (buf.length < 4) return { ok: false, reason: `TID too short (${buf.length} bytes)`, hex };

  const allocationClass = buf[0];
  const raw = { hex: buf.toString('hex').toUpperCase(), allocationClass };

  if (allocationClass !== 0xe2) {
    return {
      ok: true,
      ...raw,
      allocationClassName: ALLOCATION_CLASS[allocationClass] ?? `unknown (0x${allocationClass.toString(16)})`,
      note: 'not an EPCglobal (E2) TID — vendor/model fields do not apply',
    };
  }

  const mdid = (buf[1] << 4) | (buf[2] >> 4);
  const tmn = ((buf[2] & 0x0f) << 8) | buf[3];
  const xtid = Boolean(mdid & 0x800);
  const vendorId = mdid & 0x7ff;

  return {
    ok: true,
    ...raw,
    allocationClassName: ALLOCATION_CLASS[0xe2],
    mdid,
    mdidHex: `0x${mdid.toString(16).toUpperCase().padStart(3, '0')}`,
    xtid,
    vendorId,
    vendor: MDID_VENDORS[vendorId] ?? null,
    tmn,
    tmnHex: `0x${tmn.toString(16).toUpperCase().padStart(3, '0')}`,
    serial: buf.length > 4 ? buf.subarray(4).toString('hex').toUpperCase() : null,
  };
}

// --- bank probing ----------------------------------------------------------

/**
 * How much EPC memory the chip actually has, by reading progressively more
 * words at the EPC data offset and keeping the largest read that succeeds.
 *
 * Caveat worth knowing before trusting the number: some readers answer an
 * over-long read by silently truncating instead of erroring, which would make
 * capacity look larger than it is. Cross-check against the chip's datasheet
 * once decodeTid names it.
 *
 * @returns {{words:number, bits:number, ladder:Array<{words:number, ok:boolean}>}}
 */
function probeEpcCapacity(filter = null, accessPwd) {
  const ladder = [];
  let best = 0;
  for (const words of [6, 8, 12, 16, 20, 24, 28, 31]) {
    const r = readBankQuiet({ bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, words, filter, accessPwd });
    const ok = r.rc === 0 && r.bytes != null && r.bytes.length >= words * 2;
    ladder.push({ words, ok });
    if (ok) best = words;
    else break; // first failure is the ceiling; keep going and it just re-fails
  }
  return { words: best, bits: best * 16, ladder };
}

/** readBank that turns a thrown FFI error into an rc instead of propagating. */
function readBankQuiet(opts) {
  try {
    return uhf.readBank(opts);
  } catch (err) {
    return { rc: -1, hex: null, bytes: null, error: err.message };
  }
}

module.exports = { scanField, requireSingleTag, decodeTid, probeEpcCapacity, readBankQuiet, sleep };
