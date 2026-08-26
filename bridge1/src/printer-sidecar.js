'use strict';

/**
 * Printer sidecar: runs on the PC the LABEL PRINTER is plugged into, so a
 * bridge on another machine can print to it.
 *
 * The gate bridge needs the reader and the GPIO, so it runs on the PC wired to
 * the gate. The pallet printer is often on a different desk entirely. A bridge
 * can only ever print to a queue its OWN operating system can see, so without
 * something on this end the only route was sharing the printer over SMB and
 * installing it as a local queue on the bridge machine: two OS configurations,
 * stored Windows credentials, and a failure that looks identical to a dead
 * printer. This replaces all of that with one HTTP POST of finished bytes.
 *
 * Point the bridge at it with PALLET_SIDECAR_URL (or the pallet settings in the
 * dashboard):
 *
 *   this PC (printer):   npm run printer-sidecar
 *   the bridge PC:       PALLET_SIDECAR_URL=http://<this-pc>:3011
 *
 * Deliberately dumb: it does not build labels, know what TSPL is, or keep a
 * print log. The bridge owns the label design and the durable idempotency
 * record; duplicating either here would create a second source of truth about
 * what physically printed. This spools bytes and reports queue health.
 *
 * Same shape as the reader sidecar (sidecar-server.js) — a small HTTP service
 * fronting hardware this machine happens to own.
 */

const express = require('express');
const { execFile } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';
const PORT = Number(process.env.PRINTER_SIDECAR_PORT || process.argv[2] || 3011);

const app = express();

// The bridge POSTs raw label bytes. TSPL BITMAP payloads are binary and their
// bytes legitimately contain CR/LF, so this must stay a Buffer the whole way —
// any text parsing would corrupt a label. Limit is generous: a 300 dpi tag with
// rasterised text runs to tens of kilobytes.
app.use('/pallet/print', express.raw({ type: '*/*', limit: '8mb' }));

app.use((_req, res, next) => {
  // Same posture as the bridge's own CORS: this serves one LAN appliance, and
  // the dashboard may be served from any of several hosts.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const log = (msg) => console.log(`[printer-sidecar] ${msg}`);

/** Queue names this machine can print to. */
function listQueues() {
  return new Promise((resolve, reject) => {
    const [cmd, args] = IS_WINDOWS
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name']]
      : ['lpstat', ['-e']];
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(new Error(`queue listing failed: ${err.message}`));
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

/**
 * Is `queue` able to print right now?
 *
 * Both spoolers ACCEPT jobs for an unplugged printer, so "the queue exists"
 * proves nothing — the checks below are the same ones the bridge runs against a
 * local queue, kept deliberately identical so a remote printer is not held to a
 * weaker standard than a local one.
 */
function probeQueue(queue) {
  return new Promise((resolve) => {
    if (!queue) return resolve({ ready: false, detail: 'no queue requested' });
    if (IS_WINDOWS) {
      const ps =
        `$p = Get-Printer -Name '${queue.replace(/'/g, "''")}' -ErrorAction Stop; ` +
        `$w = Get-CimInstance Win32_Printer -Filter "Name='${queue.replace(/'/g, "''")}'"; ` +
        `$j = @(Get-PrintJob -PrinterName '${queue.replace(/'/g, "''")}' -ErrorAction SilentlyContinue); ` +
        `"$($w.DetectedErrorState)|$($j.Count)|$($w.WorkOffline)"`;
      return execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 10000 },
        (err, stdout) => {
          if (err) return resolve({ ready: false, detail: `print queue "${queue}" not found on this PC` });
          const [errState, jobs, offline] = String(stdout).trim().split('|');
          if (String(offline).toLowerCase() === 'true') {
            return resolve({ ready: false, detail: `queue "${queue}" is set to work offline` });
          }
          if (Number(errState) > 1) {
            return resolve({ ready: false, detail: `printer error state ${errState} (jam / paper out / offline?)` });
          }
          resolve({ ready: true, detail: `queue "${queue}" ready (${Number(jobs) || 0} job(s) in queue)` });
        }
      );
    }
    execFile('lpstat', ['-p', queue], { timeout: 10000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      if (err || /unable to locate|invalid destination/i.test(out)) {
        return resolve({ ready: false, detail: `CUPS queue "${queue}" not found (lpstat -p)` });
      }
      if (/disabled/i.test(out)) return resolve({ ready: false, detail: `CUPS queue "${queue}" is disabled` });
      resolve({ ready: true, detail: `queue "${queue}" ready` });
    });
  });
}

/** Hand bytes to this machine's spooler as one RAW job. */
async function spoolRaw(queue, data, docName) {
  if (IS_WINDOWS) {
    // Reuses the bridge's own winspool binding so the Windows RAW path is
    // written once, not twice.
    return require('./printer/winspool').sendRaw(queue, data, docName || 'nexus-pallet-tag');
  }
  return new Promise((resolve, reject) => {
    const child = execFile('lp', ['-d', queue, '-o', 'raw'], { timeout: 20000 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(`lp failed: ${stderr || err.message}`));
      resolve({ bytes: data.length, jobId: null });
    });
    child.stdin.end(data);
  });
}

app.get('/pallet/ready', async (req, res) => {
  const result = await probeQueue(String(req.query.queue || ''));
  res.json({ ok: true, ...result });
});

app.get('/pallet/queues', async (_req, res) => {
  try {
    res.json({ ok: true, queues: await listQueues() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/pallet/print', async (req, res) => {
  const queue = String(req.query.queue || '');
  const data = req.body;
  if (!queue) return res.status(400).json({ ok: false, error: 'queue is required' });
  if (!Buffer.isBuffer(data) || data.length === 0) {
    return res.status(400).json({ ok: false, error: 'empty body — expected raw label bytes' });
  }
  // Checked here as well as bridge-side: this is the last point before paper,
  // and the bridge's readiness answer may be up to 5s stale from its cache.
  const readiness = await probeQueue(queue);
  if (!readiness.ready) {
    log(`REFUSED ${data.length}B for "${queue}" — ${readiness.detail}`);
    return res.status(409).json({ ok: false, error: readiness.detail });
  }
  try {
    const result = await spoolRaw(queue, data, String(req.query.doc || ''));
    log(`spooled ${data.length}B -> "${queue}" (spool job ${result.jobId ?? 'n/a'})`);
    res.json({ ok: true, bytes: result.bytes ?? data.length, jobId: result.jobId ?? null });
  } catch (err) {
    log(`FAILED ${data.length}B -> "${queue}": ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** Liveness, and enough detail to tell which PC answered. */
app.get('/status', (_req, res) => {
  res.json({ ok: true, role: 'printer-sidecar', platform: process.platform, host: require('os').hostname(), port: PORT });
});

// 0.0.0.0, unlike the reader sidecar's default: the entire point is to be
// reachable from the bridge on another machine.
app.listen(PORT, '0.0.0.0', () => {
  log(`listening on http://0.0.0.0:${PORT} (${process.platform}, host ${require('os').hostname()})`);
  log(`point the bridge at it with PALLET_SIDECAR_URL=http://<this-pc-ip>:${PORT}`);
  listQueues()
    .then((q) => log(`print queues here: ${q.length ? q.join(', ') : '(none)'}`))
    .catch((err) => log(`could not list queues: ${err.message}`));
});
