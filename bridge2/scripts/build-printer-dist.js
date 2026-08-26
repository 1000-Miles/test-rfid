'use strict';

/**
 * Build a self-contained printer-sidecar package for the PC the LABEL PRINTER
 * is plugged into, and zip it.
 *
 * The gate bridge must run on the PC wired to the reader and the IR sensor. The
 * pallet printer is often on another desk, and a bridge can only print to a
 * queue its OWN operating system can see — so the printer needs something on
 * its end. This packages that something.
 *
 * Bundles node.exe and the whole node_modules tree, so the target PC needs NO
 * Node install, NO npm install and NO internet. That matters: warehouse PCs are
 * frequently locked down or offline, and "install Node first" is where a
 * five-minute setup becomes a ticket.
 *
 *   node scripts/build-printer-dist.js [--out <dir>] [--no-zip]
 *
 * Deliberately much smaller than the reader dist: no UHF DLL, no ws, no dotenv,
 * and no sharp. Labels are designed on the bridge; this end only spools bytes.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const outArg = process.argv.indexOf('--out');
const DIST = outArg !== -1 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'dist-printer');
const MAKE_ZIP = !process.argv.includes('--no-zip');

const ENTRY = 'printer-sidecar.js';

// Runtime deps only. express for the HTTP contract, koffi for the Windows
// spooler binding. Nothing else — notably NOT sharp, which is only needed where
// labels are rasterised (the bridge), and is by far the heaviest dependency.
const DEPS = { express: '^4.21.2', koffi: '^2.10.0' };

// koffi ships prebuilds for every platform it supports; a Windows printer PC
// needs exactly one. Dropping the rest is most of the package size.
const KEEP_KOFFI_PLATFORM = 'win32_x64';

const SIDECAR_PORT = 3011;

/**
 * Walk the local require graph from the entry point.
 *
 * Derived rather than hardcoded: printer/winspool.js is SHARED with the gate
 * bridge and is actively developed, so a hand-written file list goes stale the
 * moment someone adds a require — and it fails at runtime on the printer PC
 * ("Cannot find module"), not at build time here.
 */
function collectSources(entry) {
  const found = [];
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const abs = path.join(ROOT, 'src', file);
    if (!fs.existsSync(abs)) throw new Error(`missing source: src/${file} (required somewhere in the sidecar graph)`);
    found.push(file);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\('\.\/([^']+)'\)/g)) {
      queue.push(m[1].endsWith('.js') ? m[1] : `${m[1]}.js`);
    }
  }
  return found;
}

const SRC_FILES = collectSources(ENTRY);

/** Delete a tree, retrying on the transient locks antivirus/OneDrive take. */
function rmrf(p) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return;
    } catch (err) {
      if ((err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') || attempt === 6) throw err;
      console.log(`  (${p} locked — ${err.code}, retry ${attempt}/5)`);
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1200)']);
    }
  }
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function write(rel, contents) {
  const p = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // CRLF: a Windows admin opening these in Notepad expects it, and cmd.exe is
  // historically fussy about lone LF around labels.
  fs.writeFileSync(p, contents.replace(/\n/g, '\r\n'), 'utf8');
}

function sizeOf(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
  }
  return total;
}

// --- build --------------------------------------------------------------------

console.log('Building dist-printer/ ...');
rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

// 1. sources
for (const f of SRC_FILES) copy(path.join(ROOT, 'src', f), path.join(DIST, 'src', f));
console.log(`  src/        ${SRC_FILES.length} files (${SRC_FILES.join(', ')})`);

// 2. dependencies — let npm resolve the transitive tree rather than hand-picking
// express's dozen-odd internals and getting it subtly wrong.
fs.writeFileSync(
  path.join(DIST, 'package.json'),
  JSON.stringify(
    {
      name: '1000m-printer-sidecar',
      version: '1.0.0',
      private: true,
      description: 'Label-printer sidecar — lets a gate bridge on another PC print pallet tags here',
      main: 'src/printer-sidecar.js',
      scripts: { start: 'node src/printer-sidecar.js' },
      dependencies: DEPS,
    },
    null,
    2
  ) + '\n'
);
console.log('  npm install (production) ...');
// shell:true is required on Windows — since Node 18.20/20.12/22 a .cmd cannot be
// spawned directly (EINVAL), and npm on Windows is npm.cmd.
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], {
  cwd: DIST,
  stdio: 'inherit',
  shell: true,
});

// 3. prune koffi's other-platform prebuilds
const koffiBuild = path.join(DIST, 'node_modules', 'koffi', 'build', 'koffi');
if (fs.existsSync(koffiBuild)) {
  let dropped = 0;
  for (const e of fs.readdirSync(koffiBuild)) {
    if (e !== KEEP_KOFFI_PLATFORM) {
      rmrf(path.join(koffiBuild, e));
      dropped++;
    }
  }
  if (!fs.existsSync(path.join(koffiBuild, KEEP_KOFFI_PLATFORM))) {
    throw new Error(`koffi prebuild ${KEEP_KOFFI_PLATFORM} is missing — the dist could not reach the spooler`);
  }
  console.log(`  koffi       kept ${KEEP_KOFFI_PLATFORM}, dropped ${dropped} other platforms`);
}

// 4. the Node runtime itself — this is what removes the "install Node" step
copy(process.execPath, path.join(DIST, 'node.exe'));
console.log(`  node.exe    ${process.version}`);

// 5. launcher: a supervisor loop, so a crash recovers on its own rather than
// silently ending pallet printing until someone notices.
write(
  'printer-sidecar.cmd',
  `@echo off
rem Supervisor loop for the printer sidecar. Restarts on exit so a crash does
rem not silently stop all pallet printing.
cd /d "%~dp0"
if not exist logs mkdir logs

:loop
rem Crude rotation: a service that runs for months must not fill the disk.
if exist logs\\sidecar.log for %%A in (logs\\sidecar.log) do if %%~zA GTR 5242880 (
  if exist logs\\sidecar.prev.log del /q logs\\sidecar.prev.log
  ren logs\\sidecar.log sidecar.prev.log
)
echo [%DATE% %TIME%] starting printer sidecar >> logs\\sidecar.log
node.exe src\\printer-sidecar.js >> logs\\sidecar.log 2>&1
echo [%DATE% %TIME%] exited, restarting in 5s >> logs\\sidecar.log
timeout /t 5 /nobreak > nul
goto loop
`
);

// Hidden start, so an operator does not see (or close) a console window.
write(
  'start-hidden.vbs',
  `' Launch the supervisor with no visible window.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.Run "printer-sidecar.cmd", 0, False
`
);

// 6. installer. Does the three things that are easy to forget and each fail in
// a way that looks like broken hardware: the firewall rule, the autostart task,
// and (optionally) the RAW print queue.
write(
  'install.ps1',
  `#Requires -RunAsAdministrator
<#
  Printer sidecar installer.

  Sets up the three things that each fail in a way that looks like a broken
  printer rather than a missing setup step:
    1. inbound firewall rule for the sidecar port
    2. a scheduled task so it survives reboots
    3. optionally, a RAW print queue for a USB label printer

  Nothing here needs the internet, Node, or npm — both are bundled.
#>
param(
  [int]    $Port = ${SIDECAR_PORT},
  # Create a RAW print queue for a USB label printer. Skip if the printer is
  # already installed on this PC.
  [string] $PrinterName = '',
  [string] $PrinterPort = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

Write-Host "Installing 1000M printer sidecar" -ForegroundColor Cyan
Write-Host "  folder : $here"
Write-Host "  port   : $Port"
Write-Host ""

# --- 1. optional print queue -------------------------------------------------
# The Generic / Text Only driver is deliberate: labels are sent as RAW, which
# bypasses the driver entirely, so no vendor driver is needed for TSPL/ZPL.
if ($PrinterName -ne '') {
  if (Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue) {
    Write-Host "print queue '$PrinterName' already exists - leaving it alone"
  } elseif ($PrinterPort -eq '') {
    Write-Host "PrinterName given without PrinterPort - skipping queue creation" -ForegroundColor Yellow
    Write-Host "  find the port with:  Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\USB Monitor\\Ports'"
  } else {
    Add-Printer -Name $PrinterName -DriverName 'Generic / Text Only' -PortName $PrinterPort
    Write-Host "created print queue '$PrinterName' on $PrinterPort" -ForegroundColor Green
  }
}

# --- 2. firewall -------------------------------------------------------------
# Without this the sidecar starts, listens on every interface, and is still
# unreachable from the bridge - which reports it as a dead host.
$ruleName = "1000M printer sidecar $Port"
if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Write-Host "firewall rule already present"
} else {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow \`
    -Protocol TCP -LocalPort $Port -Profile Any | Out-Null
  Write-Host "opened inbound TCP $Port" -ForegroundColor Green
}

# --- 3. autostart ------------------------------------------------------------
# SYSTEM at startup, so it runs with no one logged in - a warehouse PC sitting
# at the login screen must still be able to print.
$taskName = '1000M printer sidecar'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:\$false
}
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' \`
  -Argument '"start-hidden.vbs"' -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries \`
  -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger \`
  -Settings $settings -RunLevel Highest -User 'SYSTEM' | Out-Null
Write-Host "registered startup task '$taskName'" -ForegroundColor Green

# --- 4. start now ------------------------------------------------------------
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

\$ok = \$false
try {
  \$r = Invoke-WebRequest -Uri "http://localhost:$Port/status" -TimeoutSec 8 -UseBasicParsing
  \$ok = (\$r.StatusCode -eq 200)
} catch { \$ok = \$false }

Write-Host ""
if (\$ok) {
  Write-Host "OK - sidecar is answering on http://localhost:$Port" -ForegroundColor Green
  try {
    \$q = (Invoke-WebRequest -Uri "http://localhost:$Port/pallet/queues" -TimeoutSec 8 -UseBasicParsing).Content
    Write-Host "print queues visible here:" -ForegroundColor Cyan
    Write-Host "  \$q"
  } catch { }

  \$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { \$_.IPAddress -notlike '127.*' -and \$_.IPAddress -notlike '169.254.*' }).IPAddress
  Write-Host ""
  Write-Host "NOW CONFIGURE THE BRIDGE - on the gate bridge PC, set:" -ForegroundColor Yellow
  foreach (\$ip in \$ips) { Write-Host "  PALLET_SIDECAR_URL=http://\$($ip):$Port" }
  Write-Host "  PALLET_PRINTER_NAME=<the exact queue name from the list above>"
  Write-Host ""
  Write-Host "Give this PC a STATIC or DHCP-reserved IP: the bridge stores this" -ForegroundColor Yellow
  Write-Host "address, so a changed lease silently stops all pallet printing."
} else {
  Write-Host "FAILED - no answer on http://localhost:$Port" -ForegroundColor Red
  Write-Host "  check logs\\sidecar.log"
}
`
);

write(
  'uninstall.ps1',
  `#Requires -RunAsAdministrator
param([int] $Port = ${SIDECAR_PORT})
$ErrorActionPreference = 'SilentlyContinue'

$taskName = '1000M printer sidecar'
Stop-ScheduledTask  -TaskName $taskName
Unregister-ScheduledTask -TaskName $taskName -Confirm:\$false
Write-Host "removed startup task"

Get-NetFirewallRule -DisplayName "1000M printer sidecar $Port" | Remove-NetFirewallRule
Write-Host "removed firewall rule"

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*printer-sidecar*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "stopped running sidecar"
Write-Host ""
Write-Host "The print queue was left installed. Remove it by hand if you want:"
Write-Host "  Remove-Printer -Name '<queue name>'"
`
);

// 7. the guide, shipped inside the zip so it cannot be separated from the build
write(
  'README.md',
  `# Printer sidecar

Runs on the PC the **label printer** is plugged into, so a gate bridge on
another PC can print pallet labels here.

The gate bridge has to run on the PC wired to the reader and IR sensor. A bridge
can only print to a queue its **own** operating system can see, so when the
printer is on a different PC it is simply unreachable — the bridge reports
\`queue not found\`, and no bridge setting can fix it. This closes that gap.

    gate bridge PC                    this PC
    reader + IR sensor                label printer
          |
          |  POST /pallet/print  -->  sidecar :${SIDECAR_PORT}  -->  spooler  -->  printer

Node and every dependency are bundled. **No Node install, no npm, no internet.**

## Install

1. Copy this folder somewhere permanent, e.g. \`C:\\1000M\\printer-sidecar\`.
   Not the Desktop or Downloads — the startup task runs from this path.
2. Right-click PowerShell, **Run as administrator**, then:

\`\`\`
cd C:\\1000M\\printer-sidecar
powershell -ExecutionPolicy Bypass -File install.ps1
\`\`\`

The installer opens the firewall port, registers a startup task, starts the
service, then prints this PC's IP addresses and the print queues it can see.

**If the label printer has no queue yet**, let the installer create one:

\`\`\`
powershell -ExecutionPolicy Bypass -File install.ps1 -PrinterName 'TSC T-4403E' -PrinterPort 'USB005'
\`\`\`

Find the USB port with:

\`\`\`powershell
Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors\\USB Monitor\\Ports' |
  ForEach-Object { $_.PSChildName; (Get-ItemProperty $_.PSPath)."Device Id" }
\`\`\`

The **Generic / Text Only** driver is correct and intentional — labels are sent
as RAW and bypass the driver, so no vendor driver is needed.

## Then configure the bridge

On the **gate bridge** PC:

\`\`\`
PALLET_SIDECAR_URL=http://<this-pc-ip>:${SIDECAR_PORT}
PALLET_PRINTER_NAME=<exact queue name>
\`\`\`

or live, without a restart:

\`\`\`
curl -X POST http://<bridge-ip>:3001/printer/config \\
  -H 'Content-Type: application/json' \\
  -d '{"palletSidecarUrl":"http://<this-pc-ip>:${SIDECAR_PORT}","palletPrinterName":"TSC T-4403E"}'
\`\`\`

Check \`palletSidecarUrl\` comes back in the response. An older bridge build
**silently discards** config keys it does not know, and looks like it worked.

Give this PC a **static or DHCP-reserved IP**. The bridge stores this address,
so a changed lease stops all pallet printing with no obvious cause.

## Check it

From the **bridge** PC — testing from this one proves nothing about the
firewall:

\`\`\`
curl http://<this-pc-ip>:${SIDECAR_PORT}/status
curl 'http://<this-pc-ip>:${SIDECAR_PORT}/pallet/queues'
\`\`\`

Then press **Print test label** in the gear dialog on the pallet printing page.

## When it says not ready

The message names the cause, and they need different fixes:

| Message | Cause |
|---|---|
| \`print queue "..." not found on this PC\` | queue name mismatch, or no queue installed |
| \`queue "..." is set to work offline\` | printer powered off or unplugged |
| \`printer error state N\` | jam, media out, head open, or no ribbon |
| \`pallet sidecar ... unreachable\` | this PC off, service stopped, or firewall |

That last row is the distinction worth keeping: "the printer PC is off" and "the
printer is jammed" otherwise look identical from the dashboard.

## Logs

\`logs\\sidecar.log\` in this folder. Every accepted job, every refusal and its
reason.

## Update

Replace the folder with a newer build and run \`install.ps1\` again.

## Remove

\`\`\`
powershell -ExecutionPolicy Bypass -File uninstall.ps1
\`\`\`

## What this does NOT do

It does not design labels, know what TSPL is, or keep a print log. The bridge
owns the label artwork and the durable record of what physically printed — a
second source of truth about that is exactly what a reconcile log cannot
survive. This spools bytes and reports queue health.

It also serves any number of bridges: it holds no state about who is printing,
and the queue name arrives with each request.
`
);

console.log('  launcher    printer-sidecar.cmd, start-hidden.vbs');
console.log('  installer   install.ps1, uninstall.ps1, README.md');

// 8. zip — the thing that actually gets handed to whoever sets up the PC.
if (MAKE_ZIP) {
  const zip = `${DIST}.zip`;
  fs.rmSync(zip, { force: true });
  console.log('  zipping ...');
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${DIST}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`],
    { stdio: 'inherit' }
  );
  console.log(`\nZip:  ${zip}  (${(fs.statSync(zip).size / 1024 / 1024).toFixed(0)} MB)`);
}

console.log(`Done: ${DIST}`);
console.log(`Size: ${(sizeOf(DIST) / 1024 / 1024).toFixed(0)} MB`);
