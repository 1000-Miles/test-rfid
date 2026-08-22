'use strict';

/**
 * Build the self-contained desktop-reader bridge that ships to a staff PC.
 *
 * Output: dist-reader/ — a folder that runs with NO Node install, NO npm, and
 * NO administrator rights. Copy it to the staff PC, run install.ps1, done.
 *
 *   node scripts/build-reader-dist.js
 *
 * Why a folder and not a single .exe
 * ----------------------------------
 * Two hard blockers, both from the native side:
 *
 *   1. src/uhf.js resolves the vendor DLLs as `__dirname/../lib`. Inside a Node
 *      SEA, __dirname is not a real directory, so that path stops existing.
 *   2. koffi is a native addon and UHFAPI.dll depends on libusb-1.0.dll being
 *      findable on the process PATH. Neither a .node nor a DLL can live inside
 *      a SEA blob, so both would have to be unpacked next to the exe at runtime
 *      — which is the folder we already have, plus a fragile extraction step.
 *
 * A bundled node.exe gets the same result (nothing to install, one thing to
 * replace on update) without inventing a loader.
 *
 * What ships
 * ----------
 * Only the reader's actual require graph — six source files and four packages.
 * The gate bridge's outbox, passage detection, Supabase forward, board feed,
 * printer and TTS are NOT here, and cannot be switched on by an env var because
 * the code is absent. See src/server-reader.js for the full reasoning.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// --out lets the build land outside OneDrive. Worth knowing about: this repo
// lives under OneDrive, and OneDrive grabs a lock on 88MB of freshly written
// files to sync them, which makes the next rebuild fail on rmdir (EBUSY). It
// also means every rebuild uploads the whole artifact. Building to a local path
// avoids both:
//   node scripts/build-reader-dist.js --out C:\builds\reader
const outArg = process.argv.indexOf('--out');
const DIST = outArg !== -1 && process.argv[outArg + 1] ? path.resolve(process.argv[outArg + 1]) : path.join(ROOT, 'dist-reader');

const ENTRY = 'server-reader.js';

/**
 * Walk the local require graph from the entry point.
 *
 * Derived rather than hardcoded on purpose. controller.js / driver.js / uhf.js
 * are SHARED with the gate bridge and are actively developed, so a hand-written
 * file list goes stale the moment someone adds a require — and it fails at
 * runtime on a staff PC ("Cannot find module"), not at build time here. Walking
 * the graph means the dist always ships exactly what it needs.
 *
 * Only relative requires are followed; bare specifiers are npm packages and are
 * handled by the dependency install below.
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
    if (!fs.existsSync(abs)) throw new Error(`missing source: src/${file} (required somewhere in the reader graph)`);
    found.push(file);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\('\.\/([^']+)'\)/g)) {
      queue.push(m[1].endsWith('.js') ? m[1] : `${m[1]}.js`);
    }
  }
  return found;
}

const SRC_FILES = collectSources(ENTRY);

// UHFAPI.dll + the libusb it links against. Nothing else in lib/ is needed.
const LIB_FILES = ['UHFAPI.dll', 'libusb-1.0.dll'];

// Runtime deps only. Note msedge-tts (TTS) is deliberately not here.
const DEPS = { dotenv: '^16.4.7', express: '^4.21.2', koffi: '^2.10.0', ws: '^8.18.0' };

// koffi ships prebuilds for every platform it supports; a Windows staff PC
// needs exactly one. Dropping the rest is ~90% of the package's size.
const KEEP_KOFFI_PLATFORM = 'win32_x64';

/**
 * Delete a tree, retrying on EBUSY/EPERM.
 *
 * A plain rmSync is not enough here: an antivirus scan or OneDrive sync holds a
 * transient lock on the files it has just seen, so the delete fails on a folder
 * that nothing actually has open. Retrying clears it; failing the build does not.
 */
function rmrf(p) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
      return;
    } catch (err) {
      if ((err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') || attempt === 6) throw err;
      console.log(`  (${p} locked — ${err.code}, retry ${attempt}/5)`);
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1200)']); // sleep without a dep
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
  // LF would work for .cmd, but CRLF is what a Windows admin opening these in
  // Notepad expects, and cmd.exe is historically fussy about lone LF in labels.
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

console.log('Building dist-reader/ ...');
rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

// 1. sources
for (const f of SRC_FILES) {
  copy(path.join(ROOT, 'src', f), path.join(DIST, 'src', f));
}
console.log(`  src/        ${SRC_FILES.length} files (${SRC_FILES.join(', ')})`);

// 2. vendor DLLs — must land in lib/ because uhf.js looks in __dirname/../lib
for (const f of LIB_FILES) {
  const from = path.join(ROOT, 'lib', f);
  if (!fs.existsSync(from)) throw new Error(`missing lib/${f}`);
  copy(from, path.join(DIST, 'lib', f));
}
console.log(`  lib/        ${LIB_FILES.join(', ')}`);

// 3. dependencies — let npm resolve the transitive tree rather than hand-picking
// express's dozen-odd internals and getting it subtly wrong.
fs.writeFileSync(
  path.join(DIST, 'package.json'),
  JSON.stringify(
    {
      name: '1000m-desktop-reader-bridge',
      version: '1.0.0',
      private: true,
      description: 'Reader-only RFID bridge for a staff PC (Chainway R1 desktop reader)',
      main: 'src/server-reader.js',
      scripts: { start: 'node src/server-reader.js' },
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

// 4. prune koffi's other-platform prebuilds
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
    throw new Error(`koffi prebuild ${KEEP_KOFFI_PLATFORM} is missing — the dist would not load the DLL`);
  }
  console.log(`  koffi       kept ${KEEP_KOFFI_PLATFORM}, dropped ${dropped} other platforms`);
}

// 5. the Node runtime itself — this is what removes the "install Node" step
copy(process.execPath, path.join(DIST, 'node.exe'));
console.log(`  node.exe    ${process.version}`);

// 6. launcher: a supervisor loop, so a crash or an unplugged reader recovers on
// its own instead of needing someone to notice.
write(
  'reader-bridge.cmd',
  `@echo off
rem Supervisor loop for the desktop-reader bridge. Restarts on exit so an
rem unplugged reader or a crash recovers without anyone noticing.
cd /d "%~dp0"
if not exist logs mkdir logs

:loop
rem Crude rotation: a service that runs for months must not fill the disk.
if exist logs\\reader.log for %%A in (logs\\reader.log) do if %%~zA GTR 5242880 (
  if exist logs\\reader.prev.log del /q logs\\reader.prev.log
  move /y logs\\reader.log logs\\reader.prev.log >nul
)
echo [%DATE% %TIME%] starting >> logs\\reader.log
node.exe src\\server-reader.js >> logs\\reader.log 2>&1
echo [%DATE% %TIME%] exited, restarting in 5s >> logs\\reader.log
timeout /t 5 /nobreak >nul
goto loop
`
);

// 7. hidden launcher. A scheduled task running a .cmd flashes a console window
// at every logon; wscript with window style 0 starts it with no window at all,
// and needs nothing installed.
write(
  'start-hidden.vbs',
  `' Starts reader-bridge.cmd with no visible window.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
sh.Run "cmd /c """ & here & "\\reader-bridge.cmd""", 0, False
`
);

// 8. install / uninstall
write(
  'install.ps1',
  `<#
  Installs the desktop-reader bridge on this PC.

  Deliberately per-user (LOCALAPPDATA + a logon task), so it needs NO
  administrator rights and no group policy exception. The reader is only ever
  used by the person sitting at this machine, so a per-user install matches who
  actually needs it. For a machine-wide install instead, change $Target to a
  ProgramData path and add /RU SYSTEM to the schtasks call below -- but note the
  reader is a USB HID device, so verify it still opens from session 0 first.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Port 3005
#>
param([int]$Port = 3001)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$Target = Join-Path $env:LOCALAPPDATA '1000M\\reader-bridge'
$TaskName = '1000M Desktop Reader Bridge'
$Me = "$env:USERDOMAIN\\$env:USERNAME"

Write-Host "Installing to $Target"

# The ScheduledTasks cmdlets are used instead of schtasks.exe on purpose. In
# PowerShell 5.1, redirecting a native exe's stderr (schtasks /query on a task
# that does not exist yet) wraps each line in an ErrorRecord, which trips
# $ErrorActionPreference='Stop' and aborts a perfectly normal first install.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host '  removing existing task'
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Shutdown order matters, and getting it wrong wedges the hardware.
#
# 1. Kill the supervisor shells FIRST. reader-bridge.cmd restarts node 5s after
#    it exits, so shutting node down while the loop lives just respawns it.
Get-CimInstance Win32_Process -Filter "Name='cmd.exe' or Name='wscript.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Target*" } |
  ForEach-Object { Write-Host "  stopping supervisor PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

# 2. Ask node to close the reader link cleanly. This is not politeness: a forced
#    kill skips UsbClose(), and the reader is then left with its USB endpoint
#    claimed. The next UsbOpen() returns 0 while the reader answers nothing -- a
#    phantom link that only physically replugging the cable clears. An update
#    that leaves a warehouse PC needing someone to crawl under the desk is not
#    an update.
$oldPort = 3001
$oldEnv = Join-Path $Target '.env'
if ((Test-Path $oldEnv) -and ((Get-Content $oldEnv -Raw) -match 'PORT\\s*=\\s*(\\d+)')) { $oldPort = [int]$Matches[1] }
try {
  Invoke-RestMethod -Method Post -Uri "http://localhost:$oldPort/shutdown" -TimeoutSec 5 | Out-Null
  Write-Host "  closed the reader link cleanly (port $oldPort)"
  Start-Sleep -Seconds 2
} catch {
  # Nothing listening, or an older build without /shutdown. Step 3 handles it.
}

# 3. Fallback only, so the file copy below cannot fail on a locked node.exe.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Target) } |
  ForEach-Object { Write-Host "  force-stopping node PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 500

# Copy (keep logs/ from a previous install -- they are the only history there is)
New-Item -ItemType Directory -Force $Target | Out-Null
foreach ($item in 'src','lib','node_modules','node.exe','package.json','reader-bridge.cmd','start-hidden.vbs','install.ps1','uninstall.ps1','README.md') {
  $from = Join-Path $Source $item
  if (Test-Path $from) { Copy-Item $from -Destination $Target -Recurse -Force }
}

# Port lives in .env so an update (which replaces src/) never overwrites it.
#
# -Encoding ascii rather than utf8 only for tidiness: PowerShell 5.1's utf8 emits
# a BOM. dotenv does strip it (checked), so this is not a correctness fix — it
# just keeps the file free of bytes no one expects in a PORT= line.
Set-Content -Path (Join-Path $Target '.env') -Value "PORT=$Port" -Encoding ascii

# Auto-start at logon, as the signed-in user — that is the session that owns the
# USB device. ExecutionTimeLimit 0 because this is a long-running supervisor and
# the default 3-day limit would silently kill it; IgnoreNew stops a second copy
# fighting over the reader.
$vbs = Join-Path $Target 'start-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + $vbs + '"') -WorkingDirectory $Target
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $Me
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $Me -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings \`
  -Principal $principal -Description 'Drives the Chainway R1 desktop RFID reader plugged into this PC, for Nexus.' | Out-Null
Write-Host "  registered logon task '$TaskName'"

Start-ScheduledTask -TaskName $TaskName
Write-Host '  started'

# Verify rather than assume -- an install that silently did not start is worse
# than one that failed loudly.
$ok = $false
foreach ($i in 1..20) {
  Start-Sleep -Milliseconds 500
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:$Port/status" -TimeoutSec 2
    if ($null -ne $r.connected) { $ok = $true; break }
  } catch { }
}

if ($ok) {
  Write-Host ""
  Write-Host "OK - reader bridge is answering on http://localhost:$Port" -ForegroundColor Green
  Write-Host "In Nexus, set the Reader bridge field to: http://localhost:$Port"
  Write-Host ""
  # Called out here because the bridge working is NOT sufficient, and the failure
  # it produces ("Can't reach the reader bridge") is indistinguishable from the
  # bridge being down. See README.
  Write-Host "STILL TO DO IN THE BROWSER - Chrome blocks HTTPS sites from reaching localhost:" -ForegroundColor Yellow
  Write-Host "  Click the icon left of the address bar on the Nexus page, then turn on"
  Write-Host "  'Apps on device'   (Chrome 145+, this is the localhost one)"
  Write-Host "  'Local network'    (Chrome 142-144)"
  Write-Host "  ...then reload the page. Fleet-wide: LocalNetworkAccessAllowedForUrls policy."
} else {
  Write-Host ""
  Write-Host "FAILED - no answer on http://localhost:$Port" -ForegroundColor Red
  Write-Host "Check the log: $Target\\logs\\reader.log"
  exit 1
}
`
);

write(
  'uninstall.ps1',
  `<#
  Removes the desktop-reader bridge from this PC.
  Logs are left behind on purpose; delete the folder by hand to remove them too.
#>
$ErrorActionPreference = 'Continue'
$Target = Join-Path $env:LOCALAPPDATA '1000M\\reader-bridge'
$TaskName = '1000M Desktop Reader Bridge'

# Cmdlets, not schtasks.exe — see the note in install.ps1.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host 'task removed'
} else {
  Write-Host 'no task registered'
}

# Same order as install.ps1: supervisor first, then a clean shutdown so the
# reader's USB endpoint is released. A forced kill leaves it needing a replug.
Get-CimInstance Win32_Process -Filter "Name='cmd.exe' or Name='wscript.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Target*" } |
  ForEach-Object { Write-Host "stopping supervisor PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

$oldPort = 3001
$oldEnv = Join-Path $Target '.env'
if ((Test-Path $oldEnv) -and ((Get-Content $oldEnv -Raw) -match 'PORT\\s*=\\s*(\\d+)')) { $oldPort = [int]$Matches[1] }
try {
  Invoke-RestMethod -Method Post -Uri "http://localhost:$oldPort/shutdown" -TimeoutSec 5 | Out-Null
  Write-Host 'reader link closed cleanly'
  Start-Sleep -Seconds 2
} catch { }

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Target) } |
  ForEach-Object { Write-Host "force-stopping node PID $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force }

foreach ($item in 'src','lib','node_modules','node.exe','package.json','reader-bridge.cmd','start-hidden.vbs','.env') {
  Remove-Item (Join-Path $Target $item) -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host "files removed (logs kept at $Target\\logs)"
`
);

write(
  'README.md',
  `# Desktop Reader Bridge (staff PC)

Lets Nexus use the Chainway R1 desktop reader plugged into **this** PC.

A USB reader is only visible to the machine it is plugged into, so the process
that opens it has to run here. The label printer is unaffected — Nexus keeps
sending print jobs to the server bridge.

## Install

\`\`\`
powershell -ExecutionPolicy Bypass -File install.ps1
\`\`\`

No administrator rights needed. It installs to your user profile and starts
automatically at every logon, with no visible window.

Different port:

\`\`\`
powershell -ExecutionPolicy Bypass -File install.ps1 -Port 3005
\`\`\`

## Point Nexus at it

In Tag Station / Receiving / Transfers, set **Reader bridge** to:

\`\`\`
http://localhost:3001
\`\`\`

Leave the printer setting alone.

## One-time browser permission (REQUIRED — do this on every PC)

Chrome blocks a public HTTPS site from reaching \`localhost\` until the user
allows it. Without this the Nexus Test button fails with
"Can't reach the reader bridge", and the console shows
*"Permission was denied for this request to access the \`loopback\` address space"*
— which looks exactly like the bridge not running, so it wastes a lot of time.

Click the icon left of the address bar, then:

| Chrome version | Turn on |
|---|---|
| 145 and newer | **Apps on device** (this is the loopback one — the one you need) |
| 142 - 144 | **Local network** |

Then reload the page.

On 145+, "Local network" alone is NOT enough: it covers LAN addresses
(192.168.x.x), while \`localhost\` and \`127.0.0.1\` sit in the separate loopback
space that "Apps on device" governs. Chrome shows it as
"Automatically blocked" by default.

No server change can grant this — it is a user permission, not a CORS header.
For a fleet, push it centrally instead of visiting desks, via the Chrome/Edge
policy \`LocalNetworkAccessAllowedForUrls\` set to your Nexus origin.

## Check it

\`\`\`
curl http://localhost:3001/status
\`\`\`

Log: \`%LOCALAPPDATA%\\1000M\\reader-bridge\\logs\\reader.log\`

## Update

Replace this folder with a newer build and run \`install.ps1\` again. Your port
setting in \`.env\` is preserved.

## Remove

\`\`\`
powershell -ExecutionPolicy Bypass -File uninstall.ps1
\`\`\`

## What this does NOT do

No gate/portal reader, no movement push to Nexus, no Supabase writes, no label
printing. Those all belong to the server bridge. It also refuses to connect to
the gate reader on purpose: the gate accepts one control link, so a desk taking
it would stop warehouse movement logging.
`
);

console.log('  launcher    reader-bridge.cmd, start-hidden.vbs');
console.log('  installer   install.ps1, uninstall.ps1, README.md');
console.log(`\nDone: ${DIST}`);
console.log(`Size: ${(sizeOf(DIST) / 1024 / 1024).toFixed(0)} MB`);
