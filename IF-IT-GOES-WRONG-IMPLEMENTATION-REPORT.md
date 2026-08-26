# Nexus Receiving Failure-Safeguard Implementation Report

**Prepared:** 25 August 2026  
**Scope:** RFID bridge, warehouse dashboard, Nexus Receiving, pallet printing, and Transfers  
**Operating rule:** A system or hardware problem must not leave warehouse staff with nothing to do. When automation is unavailable, work continues through a controlled local or manual fallback, and the records are reconciled afterward.

## Executive summary

The ten scenarios in `IF-IT-GOES-WRONG` were reviewed one at a time. The implementation now protects accepted scans on local disk, provides recovery instructions for power and application failures, supports manual receiving when RFID hardware cannot be used, records receiving exceptions, and keeps correction work auditable.

The main design principle is:

1. Preserve or record the physical event.
2. Let safe warehouse work continue.
3. Clearly show what the system has and has not saved.
4. Reconcile or retry without creating duplicate stock.
5. Keep an audit trail for discrepancies and corrections.

## Safeguards implemented

### 1. Internet connection drops

**Risk:** The bridge accepts RFID reads but cannot deliver them to Nexus.

**Implemented controls:**

- Every accepted movement is written and `fsync`ed to the bridge's local journal before network delivery is attempted.
- Every event has a permanent event ID. Nexus uses that ID for idempotency, preventing a retry from creating duplicate stock movements.
- The retry pump sends the oldest pending events first, uses backoff, and wakes periodically until delivery succeeds.
- Events leave the queue only after a verified acknowledgement for the same event ID.
- The dashboard reports pending delivery health and exposes exact pending or rejected event IDs.
- If the local journal itself cannot save, staff are directed to use the warehouse's manual outage log. Work does not stop merely because the internet is unavailable.

**Recovery:** When connectivity returns, queued events deliver automatically. Manual rows are entered only after checking the recovered event IDs, preventing double entry.

**Code status:** Implemented and committed in `52542fd`.

### 2. Power cut

**Risk:** Power fails while cartons are passing through the gate, making it unclear which cartons were accepted.

**Implemented controls:**

- Accepted events are flushed to disk before acknowledgement.
- Cursor and counter files use atomic replacement to avoid partially written state.
- Startup repair quarantines a torn final journal line and restores the valid journal portion.
- Pallet numbers are persisted before being issued, preventing number reuse after restart.
- A `/power-cut` recovery checklist guides staff through restart and reconciliation.
- The application does not impose a new printable form; the warehouse uses its existing manual sheet.

**Recovery:** After power returns, staff use the checklist, compare the system's last saved proof with their sheet, and enter only work not already accepted by the gate.

**Code status:** Implemented and committed in `460a8d3`.

### 3. Dashboard or application crashes

**Risk:** A worker cannot tell whether the last scan was saved and may scan or enter it again.

**Implemented controls:**

- The bridge persists the last accepted event independently of the browser.
- The dashboard restores and displays a persistent **Last Saved** proof after reload.
- The proof includes event ID, pallet or EPC, time, and delivery state such as pending, delivered, or not credited.
- Automated tests cover restoration of this evidence.

**Recovery:** Reopen the dashboard and compare the physical carton with **Last Saved** before continuing. A duplicate event ID remains harmless because ingestion is idempotent.

**Code status:** Implemented and committed in `f011487`.

### 4. RFID gate reader fails

**Risk:** The automatic count cannot be trusted or the reader is completely unavailable.

**Implemented controls:**

- The pallet confirmation screen requires the physical carton count to match the gate count before confirmation and printing.
- A mismatch provides a recount path.
- If the reader remains unavailable, staff can use **Manual Receive** instead of stopping warehouse work.
- The manual path is capped at the expected quantity and uses the same receiving recount and stock workflow.

**Recovery:** Move the pallet back through the gate for a clean recount. If hardware remains unavailable, count physically and use Manual Receive.

**Code status:** Implemented and committed in `f011487`.

### 5. Local bridge server is down

**Risk:** The local reader/print bridge exits or the production Linux host restarts.

**Implemented controls:**

- A Linux `systemd` installation script creates an `rfid-bridge.service`.
- The service starts at boot and uses `Restart=always` for automatic recovery.
- Linux deployment documentation includes installation and health-check instructions.
- If automatic restart does not restore service, staff can continue with controlled manual receiving while the bridge is recovered.

**Deployment requirement:** Run `bridge/scripts/install-systemd.sh` on the production Linux bridge and verify the service health endpoint.

**Code status:** Implemented and committed in `c2a4d07`.

### 6. Wrong SKU enters the receiving area

**Risk:** An unexpected product is accidentally credited or mixed into a pallet.

**Implemented controls:**

- The product remains visible on GateBoard with a solid red **NO RECEIVING** band.
- The exception is journaled locally but is not delivered to Nexus, credited, or added to the pallet.
- The Printing page shows the same scanned product and directs staff to add it to an active receiving batch, refresh, and scan again.
- All other correct goods can continue through receiving.

**Recovery:** If the product legitimately belongs to the delivery, add it to an active receiving batch in Nexus, refresh the gate documents, and scan it again. Continue receiving other goods throughout.

**Code status:** Implemented in `dashboard/src/GateBoard.tsx`; currently uncommitted in the bridge/dashboard repository.

### 7. Expected and received counts do not match

**Risk:** A short delivery is completed without an explanation or Purchasing follow-up.

**Implemented controls:**

- Received cartons can still be received, palletized, and posted; warehouse work does not stop.
- The completion screen calculates the shortage and displays a short-delivery panel.
- Completing a short batch requires a reason or delivery note.
- Staff record Purchasing follow-up as **Pending** or **Reported**.
- The server recalculates the shortage rather than trusting the browser.
- The database records the reason, follow-up state, reporting time, and reporting worker.
- Follow-up states support `not_required`, `pending`, `reported`, and `resolved`.

**Recovery:** Search the truck and dock first. If cartons remain missing, receive what physically arrived, record the reason, set Purchasing follow-up, and complete the batch.

**Deployment requirement:** Apply `20261122000000_receiving_shortfall_follow_up.sql` to the production database.

**Code status:** Implemented and committed in Nexus commit `f2ad6cf0`.

### 8. A carton RFID tag will not read

**Risk:** The carton is omitted or manually added in a way that later allows duplicate receiving.

**Implemented controls:**

- Manual Receive offers a **Box IDs** mode for printed cartons.
- Staff select the Box ID physically printed on the unreadable carton.
- Nexus credits the carton's real EPC through the normal deduplicated scan path.
- A later reader pass over that tag is treated as a duplicate rather than additional stock.
- Count mode remains available for a carton that genuinely has no printed Box ID.
- The dialog tells staff to keep receiving and set the carton aside for a replacement label before shipping.

**Recovery:** Use Box IDs whenever possible. Use Count only when no Box ID exists, then relabel the carton before shipment.

**Code status:** Implemented and included in the current Nexus receiving implementation.

### 9. Pallet printer fails

**Risk:** A print failure appears to undo or block a pallet that has already been built.

**Implemented controls:**

- Nexus creates the pallet and assigns its cartons before the browser calls the local printer.
- A failed print therefore leaves a valid, saved pallet.
- The failure message explicitly tells the worker that the pallet is saved and receiving can continue.
- Every saved pallet card now has a persistent **Print tag** action, so the modal can be closed and the label printed later.

**Recovery:** Continue receiving, visibly flag the unlabelled pallet, and use **Print tag** on its saved pallet card when the printer is available.

**Code status:** Implemented in `pallet-tag-print-modal.tsx` and `pallet-card.tsx`; currently uncommitted in Nexus.

### 10. Pallet is in the wrong location

**Risk:** The floor and Nexus disagree, or a correction silently overwrites history.

**Implemented controls:**

- Location corrections use **Operations → Transfers**, not an edit to the original receiving placement.
- The worker selects the pallet and scans the physical slot or selects it on the map, then confirms the move.
- An occupied destination no longer incorrectly blocks the correction because the warehouse model permits multiple pallets in a slot.
- The server independently verifies that the destination is a live slot in the selected warehouse.
- The transfer record retains source and destination, pallet, carton count, worker, and time.
- Pallet and carton location fields are updated together by the transfer workflow.

**Recovery:** Treat the physical floor as the source of truth, confirm a Transfer to that physical slot, and retain the old location in transfer history.

**Code status:** Implemented in `transfers-client.tsx` and `operations-transfer-write.ts`; currently uncommitted in Nexus.

## Verification performed

- TypeScript checking passed after the Nexus changes using `pnpm typecheck`.
- Bridge/dashboard recovery work includes automated tests for restored last-accepted event evidence.
- The HTML playbook was updated after each scenario to match the implemented workflow.
- The HTML and original Markdown playbook remain untracked and were intentionally excluded from earlier commits.

## Remaining work before production sign-off

1. Review and commit the uncommitted #6 dashboard change.
2. Review and commit the uncommitted Nexus #9 and #10 changes.
3. Apply the shortfall database migration in the production environment.
4. Install and enable the `systemd` service on the production Linux bridge.
5. Run an operational drill for internet loss, power loss, reader failure, and printer failure using real warehouse equipment.
6. Confirm where the warehouse's existing outage sheet is stored and who reconciles it after recovery.
7. Consider adding remote alerting for a bridge queue that remains delayed; current warnings require someone to see the local board.
8. Consider persisting an explicit **Label required** state for pallets. Reprinting is available now, but the application does not yet maintain a formal unlabelled-pallet work queue.

## Acceptance checklist

- [ ] Offline events survive a network outage and deliver once connectivity returns.
- [ ] A power-cycle preserves accepted events and the last saved evidence.
- [ ] Restarting the dashboard restores Last Saved without duplicating stock.
- [ ] Reader failure can be handled by recount or Manual Receive.
- [ ] The Linux bridge restarts automatically after process or host restart.
- [ ] A wrong SKU is isolated without blocking correct goods.
- [ ] A short batch cannot complete without a reason and Purchasing status.
- [ ] An unreadable carton tag can be received by its printed Box ID exactly once.
- [ ] A saved pallet can be reprinted after closing a failed-print dialog.
- [ ] A wrong-location correction validates the destination and appears in transfer history.

## Conclusion

The receiving workflow now degrades from automation to controlled manual work instead of simply stopping. The remaining items are mainly deployment, operational drills, commits for the latest changes, and two useful future improvements: remote queue alerting and a persistent unlabelled-pallet queue.
