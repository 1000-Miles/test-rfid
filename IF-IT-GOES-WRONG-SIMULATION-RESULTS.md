# Receiving Failure-Safeguard Simulation Results

**Run date:** 25 August 2026  
**Environment:** Windows development workstation; isolated scratch journals; mocked printer request; no production mutations  
**Overall result:** 5 passed, 5 partially verified, 0 failed

## Result summary

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Internet drops | **PASS** | Offline journal, ordered retry, exact acknowledgement, restart, and replay assertions passed. |
| 2 | Power cut | **PASS (software simulation)** | Torn journal tail recovery, quarantine, atomic cursor replacement, and post-restart append passed. A physical power-cut drill is still recommended. |
| 3 | App crashes | **PASS** | Last accepted event and open pallet identity survived reconstructed `Outbox` instances; dashboard TypeScript check passed. |
| 4 | Gate reader fails | **PASS (logic simulation)** | Hardware-free passage tests passed for noise, weak reads, duplicate prevention, restart, reset, and cached-board receiving. Physical reader disconnection remains to be drilled. |
| 5 | Local Linux bridge server down | **PARTIAL** | Installer contains automatic restart, boot enablement, and health check. Bash/systemd were unavailable on this Windows host, so service restart was not executed. |
| 6 | Wrong SKU | **PASS** | An off-batch known carton emits a local `no-open-batch` exception, stays outside inventory, and is never queued for Nexus or added to a pallet. |
| 7 | Count mismatch | **PARTIAL** | Server guard, reason requirement, metadata fields, migration, and TypeScript check passed. No disposable local Supabase database was available for a transaction test. |
| 8 | Tag will not read | **PARTIAL** | Box-ID guidance and real-EPC receiving path are present; duplicate prevention logic passed. Manual browser/database flow was not executed against a disposable environment. |
| 9 | Printer fails | **PASS (mocked failure)** | A simulated unreachable printer returned the intended user-facing bridge error; saved-pallet reprint control is present and Nexus type-checks. Physical printing remains to be drilled. |
| 10 | Wrong location | **PARTIAL** | Client permits the physical slot, server validates a live destination, and transfer audit insertion is present. No disposable database was available for a real transfer transaction. |

## Automated commands executed

### Bridge and dashboard

```text
node bridge1/test/outbox-offline.js
node bridge1/test/passage-toggle.js
npx tsc --noEmit             (dashboard)
```

The offline suite initially raced its own 80 ms no-IR deadline on Windows because durable `fsync` operations consumed the test window. The test-only deadline was widened to 800 ms; the production default remains 60 seconds. The rerun passed every assertion.

The dashboard's pnpm wrapper attempted a dependency-policy install and stopped on an ignored `esbuild` build script. Running the installed TypeScript compiler directly passed. This was an environment/package-policy issue, not a TypeScript failure.

### Nexus

```text
pnpm typecheck
pnpm exec tsx -e <mocked printer-offline simulation>
```

Additional non-mutating contract checks confirmed the presence of:

- Shortfall completion rejection when the reason is blank.
- Shortfall reporter and Purchasing follow-up metadata.
- Unreadable-tag Box ID instructions.
- Persistent pallet-card reprinting.
- Server-side live destination-slot validation.
- Transfer audit insertion.

## Detailed findings

### #1 Internet drops — PASS

The simulation created events with no usable network destination, stopped the bridge object, and reconstructed it from the scratch data directory. Pending events and their exact event IDs survived. Delivery remained ordered. HTML responses, mismatched IDs, unknown acknowledgement states, and `202 accepted` responses did not advance the cursor. Only a matching `applied` acknowledgement removed the event.

### #2 Power cut — PASS (software simulation)

The test appended a deliberately truncated JSON record to the journal. Startup detected and quarantined the fragment, retained the valid event, repaired the file, and accepted a clean next append. A valid final record missing only its newline was also repaired. Atomic state replacement left no temporary files.

### #3 App crash — PASS

Reconstructing the `Outbox` restored `lastAccepted`, its event ID, and pending state. An open no-IR pallet retained the same request ID and pallet code after reconstruction, and a new carton joined that restored pallet.

### #4 Gate reader fails — PASS (logic simulation)

Synthetic reader bursts verified that weak reads and one-read ghosts do not become stock, lingering tags fire only once, an already received carton is not received twice, cached receiving-board data can support offline decisions, and a deliberate receiving reset allows a withdrawn carton to be received again.

### #5 Local Linux bridge server down — PARTIAL

Static inspection confirmed:

- `Restart=always`
- `WantedBy=multi-user.target`
- `systemctl enable --now rfid-bridge.service`
- A failing `/status` health check after installation

The final acceptance test must be run on Linux:

1. Install the service.
2. Kill the Node bridge process.
3. Confirm systemd starts a new process after five seconds.
4. Reboot the host.
5. Confirm the service is active and `/status` responds.

### #6 Wrong SKU — PASS

The revised test `passage-toggle.js` verifies:

```text
the rule: a product on no open batch is shown locally but not received
ok one local exception event
ok marked NO RECEIVING
ok not received into local inventory
```

The bridge journals and broadcasts this exception locally. The Outbox deliberately excludes it from Nexus delivery and pallet sessions. GateBoard renders the product with a solid red **NO RECEIVING** band, while the Printing page carries the item and recovery instruction.

### #7 Count mismatch — PARTIAL

The code correctly recalculates shortage on the server and rejects completion with no trimmed reason. It stores the reason, Purchasing state, reporter, and timestamp. A full pass requires applying the migration to a disposable database and testing both 100/100 and 97/100 completion.

### #8 Tag will not read — PARTIAL

The manual dialog directs the worker to select the printed Box ID. That path submits the real EPC through normal receiving, allowing existing dedupe to reject a later reader pass. A full pass requires a disposable batch and a browser test: receive one box by Box ID, scan its EPC afterward, and confirm the count remains one.

### #9 Printer fails — PASS (mocked failure)

The simulated printer request failed before reaching hardware and produced the clear message that the print bridge could not be reached. Pallet assignment occurs before print, and every pallet card exposes **Print tag**, so the worker has a recovery action after closing the failure dialog.

### #10 Wrong location — PARTIAL

The code permits a correction to an occupied physical slot, rejects the current source slot, validates the destination slot server-side, updates pallet/carton location, and inserts an `operations_transfer` audit row. A full pass requires a disposable database and two real slots.

## Required next actions

1. Run #5 on the production-like Linux bridge host.
2. Create or identify a disposable Supabase test environment for #7, #8, and #10.
3. Run a physical printer drill for #9.
4. Run a physical power-cut and reader-disconnection warehouse drill.

## Sign-off status

Production sign-off still requires the environment-backed acceptance tests for #5, #7, #8, and #10.
