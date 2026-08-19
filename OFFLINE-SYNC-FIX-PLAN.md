r# Offline Sync Fix Plan — RFID Bridge + Nexus

**Date:** 2026-08-19  
**Repositories:** `test-rfid`, `1000m-nexus`  
**Scope:** Gate movement delivery, Nexus movement ingestion, dashboard reconciliation, board caching, and Nexus Label & Encode offline sync.

## Objective

Make the bridge-to-Nexus workflow reliably recoverable after WAN loss, process termination, disk-write interruption, duplicate delivery, partial database failure, and expired browser sessions.

The target delivery contract is:

1. A physical movement is assigned one stable event ID.
2. The bridge durably records it before showing it as accepted.
3. The bridge retries it until Nexus durably accepts responsibility for it.
4. Nexus applies all required effects atomically, or records unfinished work for guaranteed continuation.
5. Replaying the same event never creates a second movement or count.

## Priority 0 — Correctness blockers

### 1. Add a stable idempotency key

The current Nexus dedupe uses EPC, direction, reader, and a ±10-second timestamp window. That can collapse two legitimate passages or fail when clocks drift.

#### Bridge changes

- Add a permanent bridge identity, configured as `GATE_ID`.
- Include the journal sequence in every movement payload.
- Form an immutable event ID such as `gateId:seq`.
- Persist `gateId`, `seq`, and `eventId` inside each JSONL entry before sending.
- Do not regenerate the ID during restart or replay.

Example payload:

```json
{
  "eventId": "yiwu-main-gate:18442",
  "gateId": "yiwu-main-gate",
  "seq": 18442,
  "epc": "BC0100000000000000012345",
  "direction": "in",
  "timestamp": "2026-08-19T08:13:42.412Z"
}
```

#### Nexus changes

- Extend the movement request schema with `eventId`, `gateId`, and `seq`.
- Add `source_event_id` to the durable movement/scan record.
- Add a unique database constraint on `source_event_id`.
- On duplicate-key conflict, load and return the existing result as a successful idempotent response.
- Keep the time-window probe temporarily for old bridge versions only.
- Validate timestamps for operational ordering, but do not use timestamps as the primary idempotency key.

#### Acceptance criteria

- Replaying one event 100 times creates one movement record and one set of business effects.
- Two same-EPC, same-direction events one second apart with different event IDs both apply.
- Clock skew does not create duplicates or suppress legitimate movements.

### 2. Make Nexus movement application atomic

Nexus currently inserts a scan and then performs status updates, receiving credit, stock posting, shipment credit, placement, and pallet correlation through separate calls. Some failures are logged but the route still returns HTTP 200, causing the bridge to discard the event.

#### Preferred implementation

- Move the critical database work into a Postgres RPC executed in one transaction.
- Treat these as required effects where applicable:
  - movement/scan insert;
  - carton or pallet status transition;
  - receiving-batch credit;
  - shipment credit;
  - stock-ledger mutation;
  - durable recording of any follow-up work.
- Use constraints and conditional updates to make the RPC idempotent by `source_event_id`.
- Return the previously stored result for an already-applied event.

#### If one transaction is impractical

- Add a `gate_movement_ingest` table with:
  - `source_event_id` unique;
  - original payload;
  - `status` (`pending`, `processing`, `applied`, `failed`);
  - per-step completion flags or a result document;
  - attempt count and last error;
  - created/updated/applied timestamps.
- The API may return 200 only after the event is `applied` or durably queued for guaranteed server-side processing.
- Add a worker/cron that resumes incomplete records.
- Expose incomplete and failed counts in operational diagnostics.

#### HTTP contract

- `200`: fully applied or already applied.
- `202`: durably accepted for guaranteed server-side continuation.
- `400`: permanently invalid payload; bridge dead-letters it.
- `401`, `403`, `409`, `429`, `5xx`: retryable unless the response explicitly declares a permanent validation failure.
- Include `eventId`, final state, and incomplete effects in the response.

#### Acceptance criteria

- Injecting failure after the scan insert does not produce an acknowledged partial movement.
- Every retry converges on one complete result.
- There is a query/dashboard for accepted but incomplete movements.

### 3. Journal before broadcasting

The bridge currently broadcasts a movement to the dashboard before the journal append succeeds.

#### Changes

- Call `outbox.enqueue(event)` before `broadcast(event)`.
- Return the assigned `seq` and `eventId` from `enqueue`.
- Broadcast the enriched, durably journaled event.
- If journal persistence fails:
  - do not broadcast the movement as accepted;
  - raise a persistent critical alarm;
  - expose a failed-journal counter and last error through `/status`;
  - consider pausing reader acceptance until storage health is restored.

#### Acceptance criteria

- A forced disk-write failure never increments the dashboard.
- Every dashboard movement can be found by its event ID in the journal.

### 4. Repair torn JSONL tails

Skipping a malformed final line is insufficient because the next append can join onto that fragment and make subsequent entries unreadable.

#### Changes

- On startup, scan the journal as bytes or complete newline-delimited records.
- If only the final line is malformed:
  - copy the fragment to a quarantine file for diagnosis;
  - truncate the journal to the last complete newline;
  - fsync the repaired file and its directory;
  - log and expose a recovery warning.
- If corruption occurs before the final line, stop automatic delivery and require explicit recovery; do not silently skip an interior record.
- After repair, calculate `nextSeq` from all valid archive and active records.

#### Acceptance criteria

- A process killed halfway through an append recovers cleanly.
- A new event appended after recovery remains readable after another restart.
- Interior corruption is visible and cannot silently advance the cursor.

## Priority 1 — Storage and reconciliation resilience

### 5. Use atomic file replacement

Apply atomic writes to:

- `movement-cursor.json`;
- `board-cache.json`;
- `catalog.json`;
- any other file whose truncation could remove the last usable snapshot.

#### Safe-write procedure

1. Write the complete content to a temporary file in the same directory.
2. Flush the file with `fsync`.
3. Rename the temporary file over the destination.
4. Where supported, fsync the containing directory.
5. Retain one last-known-good board/catalog backup.

#### Acceptance criteria

- Killing the process during any cache/cursor write leaves either the old or new complete file.
- An offline cold boot can load the last-known-good board after an interrupted refresh.

### 6. Strengthen outbox response handling

- Parse the Nexus success response instead of treating every 2xx as equivalent.
- Advance the cursor only when Nexus returns the matching `eventId` and a state of `applied` or durably `accepted`.
- Treat malformed success bodies as retryable protocol errors.
- Preserve strict sequence ordering.
- Add bounded response-body logging with secrets removed.
- Keep permanent validation failures in a dead-letter file, including the payload and Nexus response.
- Add a supported command/API for correcting and requeuing dead letters.

#### Acceptance criteria

- A proxy-generated HTML 200 does not remove an event from the queue.
- A mismatched response event ID does not advance the cursor.

### 7. Reconcile the dashboard by event ID

The dashboard currently retires local overlays using queue depth and timestamps. This is indirect and can retire the wrong credit.

#### Changes

- Store `eventId` on each pending dashboard credit.
- Have the bridge expose per-event delivery/acknowledgement state or a delivered high-water mark scoped to `gateId`.
- Prefer a Nexus feed containing absorbed event IDs or the highest contiguous applied sequence.
- Retire a local overlay only when that exact event is confirmed applied and the returned Nexus snapshot includes it.
- Continue using local persistence so an offline page reload retains unconfirmed credits.

#### Acceptance criteria

- One missing event followed by later successful events cannot disappear from the overlay.
- Multiple events with identical EPC/timestamps reconcile independently.

## Priority 2 — Nexus browser offline sync

### 8. Make queued label marks observable

- Display queued count, oldest queued age, last attempt, and last error.
- Distinguish offline/network failure from authentication failure.
- On `401`, show “Sign in to finish syncing” instead of silently retrying forever.
- Retry immediately after successful login.
- Warn before sign-out when unsynchronized marks remain.

### 9. Harden concurrent queue flushing

- Prevent the page and service worker from flushing the same queue concurrently, using an IndexedDB lease/lock or equivalent coordination.
- Delete only records whose version or enqueue timestamp matches the snapshot that was successfully sent.
- Batch large queues and impose payload limits.
- Close IndexedDB handles when appropriate and handle version changes.

### 10. Add fetch timeouts and cache metadata

- Put a timeout around service-worker network-first requests so an offline reload does not hang on slow network detection.
- Record cache version and fetch time.
- Show the age of cached Operations data to the operator.
- Do not imply that cached pages make all Operations mutations offline-capable.

## Operational visibility

Expose the following in bridge `/status` and the administrative UI:

- journal writable/healthy;
- active journal size;
- queue depth and oldest queued age;
- last accepted event ID;
- last Nexus response/error;
- retry backoff and next attempt;
- dead-letter count;
- recovered torn-write count;
- board/catalog cache age;
- bridge clock offset;
- Nexus incomplete-ingest count.

Alert conditions:

- journal write failure: immediate critical;
- oldest queued movement over 5 minutes: warning;
- oldest queued movement over 30 minutes: critical;
- any dead letter: warning requiring review;
- Nexus accepted-but-incomplete record over 5 minutes: critical;
- board/catalog cache older than the operational threshold: warning.

## Required automated tests

### Bridge unit/integration tests

- offline enqueue survives restart;
- strict ordering after reconnect;
- timeout/network/401/403/429/5xx retry behavior;
- permanent 400 dead-letter behavior;
- malformed 2xx response remains queued;
- torn-tail recovery;
- interior-corruption detection;
- cursor corruption causes safe idempotent replay;
- disk-write failure prevents broadcast;
- atomic cache/cursor interruption tests;
- journal rotation with an existing archive;
- replay preserves original event IDs.

### Nexus tests

- duplicate event ID is idempotent;
- distinct IDs inside ten seconds both apply;
- concurrent duplicate requests apply once;
- injected failure at every processing step converges after retry;
- receiving and shipment counts cannot partially commit;
- legacy requests remain compatible during rollout;
- expired-session label queue remains stored and resumes after login;
- page and service-worker concurrent flush cannot lose a queued record.

### End-to-end outage drill

1. Start with an empty outbox and known Nexus counts.
2. Disconnect WAN access while leaving the reader and bridge running.
3. Pass a mixture of cartons and pallets in both directions.
4. Restart the bridge during the outage.
5. Confirm the dashboard retains all provisional movements.
6. Restore WAN access.
7. Confirm strict ordered drain and zero dead letters.
8. Restart both systems and replay the complete journal.
9. Confirm movement rows, warehouse states, receiving counts, shipment counts, and stock ledger remain unchanged after replay.

## Rollout sequence

1. Add Nexus schema support for nullable `source_event_id`, `gate_id`, and `source_seq`.
2. Deploy Nexus support for both legacy timestamp dedupe and new event-ID dedupe.
3. Add bridge event IDs, journal repair, journal-first broadcast, and strict acknowledgement parsing.
4. Observe dual-compatible traffic and verify idempotency metrics.
5. Backfill event IDs where safely derivable from retained bridge journals.
6. Make event ID required for configured production gates.
7. Replace multi-step Nexus application with a transaction or durable ingest state machine.
8. Move dashboard reconciliation from timestamps to event IDs.
9. Deploy browser queue visibility and concurrency protection.
10. Run the end-to-end outage drill before declaring the workflow loss-proof.

## Definition of done

- No accepted bridge movement can exist only in browser state.
- No HTTP success can conceal an unfinished required Nexus effect.
- Every movement has a stable, unique identity across retries and replay.
- Power loss cannot corrupt the last valid journal, cursor, board cache, or catalog snapshot without detection.
- Operators can see backlog, failures, stale data, and authentication-blocked sync.
- Automated tests cover network loss, process death, partial writes, partial database failures, concurrency, replay, and session expiry.
- A documented outage drill completes with zero lost movements, zero duplicate counts, and no unexplained manual reconciliation.

