'use strict';

/**
 * Driver selector: UHF_DRIVER=dll (default on Windows) | sidecar.
 * On non-Windows platforms the DLL cannot load, so sidecar is forced.
 */

const requested = (process.env.UHF_DRIVER || '').toLowerCase();
const useSidecar = requested === 'sidecar' || (process.platform !== 'win32' && requested !== 'dll');

const driver = useSidecar ? require('./uhf-sidecar') : require('./uhf');

if (!driver.capabilities) driver.capabilities = { hw: true, ioStatusDebug: true }; // DLL driver

// DLL driver has pollTag but no drainTags — add the batch shim so the
// controller can use one interface for both drivers.
if (!driver.drainTags) {
  driver.drainTags = (max = 100) => {
    const out = [];
    let tag;
    while (out.length < max && (tag = driver.pollTag())) out.push(tag);
    return out;
  };
}

console.log(`[driver] using ${useSidecar ? 'sidecar (Java SDK over HTTP)' : 'dll (koffi + UHFAPI.dll)'}`);

module.exports = driver;
