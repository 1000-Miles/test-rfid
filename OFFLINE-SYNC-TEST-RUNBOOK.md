# Offline Sync Test Runbook — RFID Bridge + Nexus

**Date:** 2026-08-19  
**Repositories:** `test-rfid`, `1000m-nexus`

> [!WARNING]
> Run the full integration test against a local or staging database, not production. The test creates and deletes synthetic database rows, and its outbound scenarios could affect open shipment counts when pointed at live data.

## Purpose

This runbook verifies:

- bridge journal durability while Nexus is unreachable;
- recovery after a bridge restart;
- strict ordered delivery after reconnection;
- stable event-ID idempotency;
- concurrent duplicate handling;
- event-ID collision detection;
- Nexus continuation-ledger recovery;
- replay without duplicate database effects.

## Prerequisites

Apply the gate-movement migration manually after confirming these tables already exist:

- `operations_tag_scan`
- `operations_shipment_line`
- `operations_shipment_destination`
- `operations_pallet_event`

Confirm the Nexus `.env.local` staging configuration includes:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MOVEMENT_API_KEY
CRON_SECRET
```

Confirm the bridge has a permanent identity:

```text
GATE_ID=yiwu-main-gate
```

## 1. Run code-level tests

### Bridge

```powershell
cd C:\Users\Joshua\Documents\1000miles\test-rfid\bridge
npm.cmd run test-outbox
npm.cmd run test-toggle
```

Expected result: both suites exit successfully with no failed assertions.

### Nexus

```powershell
cd C:\Users\Joshua\Documents\1000miles\1000m-nexus
pnpm.cmd typecheck
```

Expected result: TypeScript exits successfully with no errors.

## 2. Start Nexus against staging

```powershell
cd C:\Users\Joshua\Documents\1000miles\1000m-nexus
pnpm.cmd dev
```

Leave this terminal running. By default, the integration script expects Nexus at `http://localhost:3000`.

To use another address, set `TEST_BASE_URL` in the terminal that runs the test:

```powershell
$env:TEST_BASE_URL="https://your-staging-nexus.example.com"
```

## 3. Run the Nexus integration test

Open another terminal:

```powershell
cd C:\Users\Joshua\Documents\1000miles\1000m-nexus
pnpm.cmd tsx scripts/test-gate-event-id.ts
```

Expected result: the script reports zero failures.

This test verifies:

- repeated delivery creates one movement;
- concurrent duplicates apply once;
- distinct event IDs both apply;
- reused event IDs with different payloads return HTTP 409;
- legacy delivery still works;
- interrupted events resume through the cron;
- an older resumed event does not overwrite newer warehouse state.

If the resume section says `SKIPPED`, `CRON_SECRET` is missing from the test environment.

## 4. Prove the integration test detects broken idempotency

Stop the normal Nexus development server. Restart it with the test-only kill switch:

```powershell
cd C:\Users\Joshua\Documents\1000miles\1000m-nexus
$env:GATE_TEST_DISABLE_EVENT_DEDUPE="1"
pnpm.cmd dev
```

In the test terminal:

```powershell
cd C:\Users\Joshua\Documents\1000miles\1000m-nexus
pnpm.cmd tsx scripts/test-gate-event-id.ts --sabotage
```

Expected result:

```text
SABOTAGE OK
```

This proves the normal test can detect a broken event-ID implementation.

Stop Nexus and clear the kill switch afterward:

```powershell
Remove-Item Env:GATE_TEST_DISABLE_EVENT_DEDUPE -ErrorAction SilentlyContinue
```

Restart Nexus normally before continuing:

```powershell
pnpm.cmd dev
```

## 5. Test an offline bridge restart

> [!IMPORTANT]
> Use staging Nexus for this drill. The bridge journal is real and survives process restarts.

Start the bridge with an intentionally unreachable Nexus URL:

```powershell
cd C:\Users\Joshua\Documents\1000miles\test-rfid\bridge
$env:NEXUS_URL="http://127.0.0.1:9/api/movement"
node src/server.js
```

In another terminal, generate a synthetic inbound passage:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8787/debug/mock-passage `
  -ContentType application/json `
  -Body '{"epc":"FADE00000000000000FF1001","direction":"in"}'
```

Wait approximately two seconds and inspect the bridge queue:

```powershell
Invoke-RestMethod http://localhost:8787/movement/status |
  ConvertTo-Json -Depth 5
```

Expected state:

- `queueDepth` is at least `1`;
- `journal.healthy` is `true`;
- `lastError` reports the failed connection;
- the event remains in the durable journal.

Stop the bridge with Ctrl+C. Clear the temporary URL and restart using the normal `.env` configuration:

```powershell
Remove-Item Env:NEXUS_URL -ErrorAction SilentlyContinue
node src/server.js
```

Check the status repeatedly while the outbox drains:

```powershell
Invoke-RestMethod http://localhost:8787/movement/status |
  ConvertTo-Json -Depth 5
```

Expected final state:

- `queueDepth` is `0`;
- `lastError` is `null`;
- `lastPushAt` is populated;
- `cursor` advanced;
- `deadLetters` is `0`;
- `journal.healthy` remains `true`.

## 6. Test replay idempotency

Find the sequence number of the synthetic event in the bridge journal or status output. Replay from that sequence:

```powershell
$body = @{ fromSeq = YOUR_SEQUENCE_NUMBER } | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:8787/movement/replay `
  -ContentType application/json `
  -Body $body
```

Wait for `queueDepth` to return to zero:

```powershell
Invoke-RestMethod http://localhost:8787/movement/status |
  ConvertTo-Json -Depth 5
```

Verify in staging Nexus that the replay produced:

- exactly one `operations_tag_scan` row for the event's `source_event_id`;
- no second receiving credit;
- no second shipment credit;
- no second stock-ledger movement;
- no second pallet-placement audit event.

## 7. Optional failed-event recovery test

The secured recovery endpoint is:

```text
POST /api/cron/gate-ingest
Authorization: Bearer <CRON_SECRET>
Content-Type: application/json

{"eventId":"<failed-event-id>"}
```

PowerShell example:

```powershell
$headers = @{ Authorization = "Bearer $env:CRON_SECRET" }
$body = @{ eventId = "yiwu-main-gate:123" } | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/api/cron/gate-ingest `
  -Headers $headers `
  -ContentType application/json `
  -Body $body
```

Expected response for an existing failed event:

```json
{
  "ok": true,
  "eventId": "yiwu-main-gate:123",
  "requeued": true
}
```

Use this only after correcting the underlying cause of the failure. The bridge retains the failed event at its strict queue head and resumes automatically after the event is requeued and successfully applied.

## Pass criteria

The offline-sync implementation is accepted when:

- all bridge tests pass;
- Nexus typechecking passes;
- the normal Nexus integration test has zero failures;
- sabotage mode reports `SABOTAGE OK`;
- an event created while Nexus is unreachable survives a bridge restart;
- reconnection drains the queue in order with zero dead letters;
- replay creates no duplicate movement or business effects;
- event-ID payload collisions return HTTP 409;
- journal health remains good throughout the drill.

