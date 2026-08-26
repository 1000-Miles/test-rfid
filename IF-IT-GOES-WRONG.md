# If it goes wrong — Nexus Receiving failure playbook

One section per failure case: what the problem really is, what our system **already implements** (verified in code), and what is **not implemented** — so nobody mistakes a manual procedure or a plan for a built safeguard.

Interactive version (flowchart / workflow / implementation tabs): https://claude.ai/code/artifact/29c7cb73-5226-48a8-8a23-b6eaa68aeee4 — offline copy in this repo: [IF-IT-GOES-WRONG.html](IF-IT-GOES-WRONG.html)

**Three rules, everywhere:** never confirm a pallet you know is wrong; never put goods away without a system or manual outage record; a system failure changes the recording method — it never stops warehouse work.

> **Status note (2026-08-25):** the bridge is currently in NO-RECORD test mode (since 2026-08-20) — while that lasts, nothing reaches Nexus/Supabase regardless of what this document says. Revert the `.env` TEST MODE markers before relying on any of the delivery behavior below.

---

## 1 · Internet drops — Routine

**The problem.** The warehouse WAN link dies mid-receiving. Every carton crossing the gate still has to end up in Nexus, exactly once, in the order it happened — hours or days later.

**Already implemented**
- Every gate event is appended and fsynced to `data/movement-log.jsonl` **before any network attempt**; the write is the record, the network is just delivery (`bridge/src/outbox.js`).
- Each event carries a permanent ID (`gateId:generation:seq`) stamped before journaling; Nexus dedupes on it (`operations_gate_ingest` keys idempotency on `source_event_id`).
- Retry pump: backoff 1s→60s cap, a 15-second timer re-wakes it forever, no retry limit, no expiry. Drain is strictly oldest-first, throttled ~5 events/s.
- An event leaves the queue only on a verified `applied` acknowledgement with the matching event ID. Permanent rejections (HTTP 400) go to `movement-dead.jsonl`, never silently dropped.
- `/status` exposes queue depth, oldest-pending age, last error, journal health. `replay()` can re-send any range of history safely.
- The gate dashboard polls delivery health every 15 seconds. A movement waiting 5 minutes raises an amber warehouse-visible warning. At 30 minutes the red alert says to keep receiving on the local queue and call IT. Journal/disk failure instead orders an immediate switch to the manual outage log; rejected goods are set aside while unaffected receiving continues.
- Dashboard overlay credits retain their permanent event IDs. The bridge reports the exact pending and dead-letter IDs, so each local credit retires only after that specific event is no longer pending and a newer Nexus snapshot has arrived; rejected events remain visible.

**Not implemented**
- **No remote paging.** Alerts are visible on the gate dashboard, but there is still no SMS, email, or external on-call notification when nobody is looking at it.

## 2 · Power cut — Caution

**The problem.** Reader, PC, local server and printer all die at once. Goods keep arriving; nothing electronic can record them, and whatever was recorded before the cut must survive.

**Already implemented**
- fsync-before-acknowledge: an event shown on screen is already on disk, so a cut cannot lose an accepted event.
- Cursor and pallet counters are written atomically (temp file + rename, `bridge/src/atomic-write.js`); pallet numbers hit disk before they are handed out, so a reboot can't reissue one.
- Boot repair: a journal line torn mid-write is quarantined and the file truncated to the last complete record; interior corruption pauses delivery on purpose and demands a human (`_repairJournal`).
- Recovery on power-return is automatic: journal + cursor restore the exact queue and the pump resumes alone.
- The catch-up path exists in Nexus: Operations → Receiving → the batch → 4-step wizard (Source → Received with **+ Manually receive** → Pallets with floorplan slot placement → Sync/Complete).
- `/power-cut` provides a print-ahead outage sheet with arrival time, PO/batch, SKU, cartons, pallet/stage, intended slot, damage, and a mandatory **SCANNED / NOT SCANNED** distinction. Its recovery checklist explicitly forbids manually re-entering rows that the gate accepted before the cut.

**Not implemented**
- **Writing during the cut is necessarily human.** The system supplies a standard print-ahead sheet and recovery checklist, but cannot enforce writing while every device has no power; blank copies must be kept at the gate.
- No UPS / battery backstop for the reader, PC or server.
- Manual Receive needs Nexus (Supabase) reachable — a power cut that also takes the router means the catch-up waits for both power **and** internet.

## 3 · App crashes — Routine

**The problem.** The receiving screen freezes or the browser dies mid-shift, and the operator can't tell whether the last pallet was recorded.

**Already implemented**
- The browser is only a viewer. A movement is broadcast to dashboards **only after** the journal append succeeds — a disk failure means "not counted, not broadcast", loudly (`bridge/src/server.js:363`).
- The dashboard detects a silent WebSocket and reconnects itself (`dashboard/src/useBridge.ts`).

**Not implemented**
- The hydration / reconnect / stale-state fixes written on 2026-08-20 are **inactive until the bridge is restarted** — as of this document the running process predates them.

## 4 · Gate reader fails — Caution

**The problem.** RF is imperfect: the gate reads 14 tags where 20 cartons passed. Undercount must be fixable without ever double-counting.

**Already implemented**
- Re-reads can never double: the bridge counts one carton once, and Nexus dedupes per EPC-per-batch **and** per physical box (a reprinted label's sibling EPCs collapse onto the same carton — `recordReceiveScanCore`).
- Gate and handheld feed the identical credit path; slow re-runs just add the tags that were missed.
- Expected vs received is tracked per line, so the shortfall is visible on the batch.
- Signal tuning tooling exists (`bridge/test/calibrate-signal.js`).

**Not implemented**
- **No undercount alarm.** The system shows 14/20 but doesn't flag or block anything; noticing is on the operator (count by eye, check the packing list).
- No carton-barcode fallback (see §8) — the fallback for unreadable tags is `+ Manually receive`.

## 5 · Local server down — Stop

**The problem.** The bridge process or its machine dies. Every device loses the app; receiving has no system until it's back.

**Already implemented**
- Everything lives on disk (journal, cursor, counters); a dead process loses nothing. Boot restores the pending queue exactly (`outbox._restore`).
- `/status` distinguishes a failing disk (`enqueueFailures`) from a mere restart.

**Not implemented**
- **No watchdog / auto-restart / failover.** IT restarts the box by hand; there is one machine, no standby.
- Same gap as §2: during the outage the fallback is paper, unsupported by the system.

## 6 · Wrong SKU — Stop

**The problem.** A pallet arrives carrying a product that isn't on any open PO. It must not slip into stock alongside the good cartons.

**Already implemented**
- Each tag resolves to its product; if the batch has no line for it, the scan lands as status **`unexpected`** — logged, but the line is never credited (`recordReceiveScanCore`).
- On the bridge, contested cartons are journaled but never queued, never counted into a pallet session, and never printed on a pallet tag (`bridge/src/outbox.js`).

**Not implemented**
- **There is no "Confirm blocked" button** — that flowchart phrase is shorthand. The real mechanism is "never credited, kept off pallets"; nothing visibly locks a screen.
- Quarantine, photo, and reporting to Purchasing are entirely manual — no notification, no wrong-goods workflow in the system.

## 7 · Count mismatch — Caution

**The problem.** The PO says 100, the truck yields 97. The 97 must enter stock today without the missing 3 being papered over.

**Already implemented**
- Line counts come from a recount RPC (`operations_recount_received`) — never client math.
- `+ Manually receive` is capped at the expected count: receiving 101 of 100 is impossible.
- Stock posts only what was actually received; a batch **can** complete short, and the gap stays visible as received/expected on the line.

**Not implemented**
- **No discrepancy-note feature.** The flowchart's "add a discrepancy note to the PO" is a manual act outside this system (message/Odoo); nothing in Nexus records a structured shortfall note.
- No automatic escalation to Purchasing — the only system trace is the line sitting at 97/100.

## 8 · Tag won't read — Routine

**The problem.** One carton's RFID tag is missing or dead; the carton is real and must be counted anyway.

**Already implemented**
- `+ Manually receive` inserts `MAN-…` rows into the **same** scan table with the same recount — a manual carton is indistinguishable downstream from a scanned one (`recordManualReceiveCore`).
- A reprinted label keeps the carton's identity through its box id, so re-tagging can't double-count.
- Fresh tags can be encoded (Tag Station page in Nexus; desk encoder via the bridge).

**Not implemented**
- **No carton-barcode receiving.** The flowchart's "scan the barcode" path does not exist — in this system barcodes identify *slots* (Transfers), not cartons. The real fallback is manual receive.

## 9 · Printer fails — Routine

**The problem.** Labels run out or Bluetooth drops right after a pallet is received. The pallet must stay tracked and get its label later.

**Already implemented**
- The record is complete before printing starts — printing is fully decoupled from receiving.
- Reprint reproduces the original label any time; a print-once guard stops accidental doubles, with reprint as the one deliberate exception (`dashboard/src/PalletPrintingPage.tsx`).
- A print log records what printed.

**Not implemented**
- **No "needs label" flag.** The flowchart's "flag it for labelling" isn't a feature; the closest thing is the printing page's list of pallets and their print state. An unlabelled pallet is caught by people, not by the system.

## 10 · Wrong location — Routine

**The problem.** The system says slot B-12; the pallet is physically in D-03. The map must match the floor again with one action.

**Already implemented**
- Placement during receiving is first-time-only; every later move is a **Transfer** (Operations → Transfers: scan the slot barcode or click the map, then Confirm — `transfers-client.tsx`).
- Slot barcodes are unique-constrained — a scan can never resolve to two slots.

**Not implemented**
- **No walk-up handheld fix.** The flowchart's "go to the pallet and scan the correct slot" isn't a standalone flow — the move happens in the Transfers screen on a PC/iPad (which does accept a scanned slot barcode as input). There is no scan-at-the-rack shortcut that updates location by itself.

---

*Verified 2026-08-25 against `bridge/src/outbox.js`, `bridge/src/server.js`, `dashboard/src/useBridge.ts`, `dashboard/src/PalletPrintingPage.tsx` (this repo) and `src/app/operations/receiving/receiving-client.tsx`, `src/lib/operations-receiving-write.ts`, `src/app/operations/transfers/transfers-client.tsx` (1000m-nexus).*
