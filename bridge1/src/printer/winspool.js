'use strict';

/**
 * RAW printing through the Windows spooler (winspool.drv via koffi).
 *
 * A job submitted with datatype "RAW" bypasses the driver's renderer entirely:
 * the spooler hands our bytes (ZPL) straight to the port monitor (e.g. USB001).
 * That's why the CP30 queue can use the built-in "Generic / Text Only" driver —
 * the driver never touches RAW jobs, so no vendor driver is needed for USB.
 */

const koffi = require('koffi');

let fns = null;

/** Bind the winspool exports we use. Idempotent. */
function load() {
  if (fns) return fns;
  if (process.platform !== 'win32') throw new Error('winspool printing is Windows-only');

  const winspool = koffi.load('winspool.drv');
  const kernel32 = koffi.load('kernel32.dll');

  koffi.struct('DOC_INFO_1W', {
    pDocName: 'str16',
    pOutputFile: 'str16',
    pDatatype: 'str16',
  });

  fns = {
    // BOOL is a 4-byte int in Win32, hence 'int' not 'bool'.
    OpenPrinterW: winspool.func('int OpenPrinterW(str16 pPrinterName, _Out_ void **phPrinter, void *pDefault)'),
    StartDocPrinterW: winspool.func('uint32 StartDocPrinterW(void *hPrinter, uint32 level, DOC_INFO_1W *pDocInfo)'),
    StartPagePrinter: winspool.func('int StartPagePrinter(void *hPrinter)'),
    WritePrinter: winspool.func('int WritePrinter(void *hPrinter, const uint8_t *pBuf, uint32 cbBuf, _Out_ uint32 *pcWritten)'),
    EndPagePrinter: winspool.func('int EndPagePrinter(void *hPrinter)'),
    EndDocPrinter: winspool.func('int EndDocPrinter(void *hPrinter)'),
    ClosePrinter: winspool.func('int ClosePrinter(void *hPrinter)'),
    GetLastError: kernel32.func('uint32 GetLastError()'),
  };
  return fns;
}

/**
 * Send raw bytes to a Windows print queue as one RAW document.
 * Returns { jobId, bytes }. Throws with the Win32 error code on failure.
 */
function sendRaw(printerName, data, docName = 'ZPL label') {
  const f = load();
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');

  const hOut = [null];
  if (!f.OpenPrinterW(printerName, hOut, null)) {
    throw new Error(
      `OpenPrinter("${printerName}") failed (Win32 error ${f.GetLastError()}) — does that print queue exist?`
    );
  }
  const h = hOut[0];
  try {
    const jobId = f.StartDocPrinterW(h, 1, { pDocName: docName, pOutputFile: null, pDatatype: 'RAW' });
    if (!jobId) throw new Error(`StartDocPrinter failed (Win32 error ${f.GetLastError()})`);
    try {
      if (!f.StartPagePrinter(h)) throw new Error(`StartPagePrinter failed (Win32 error ${f.GetLastError()})`);
      const written = [0];
      if (!f.WritePrinter(h, buf, buf.length, written)) {
        throw new Error(`WritePrinter failed (Win32 error ${f.GetLastError()})`);
      }
      f.EndPagePrinter(h);
      if (written[0] !== buf.length) {
        throw new Error(`WritePrinter wrote ${written[0]}/${buf.length} bytes`);
      }
      return { jobId, bytes: written[0] };
    } finally {
      f.EndDocPrinter(h);
    }
  } finally {
    f.ClosePrinter(h);
  }
}

module.exports = { sendRaw };
