# Nexus handoff — gate ingest defects

**From:** RFID gate bridge, Yiwu main gate (`GATE_ID=yiwu-main-gate`)
**First raised:** 2026-08-22 · **Revised:** 2026-08-24
**Scope:** everything below is **server-side**. The bridge reports "EPC X passed the
gate"; Nexus decides what that means. None of it is fixable from the doorway.

**Changed in the 2026-08-24 revision:** item 3 (short `palletCode`) is now a
firm request with the bridge side already built and waiting; item 6 (receiving
reset marker) is new; **item 7 is a payload change you need to know about, and a
disclosure of bad data this gate produced.** Items 1, 2, 4 and 5 are unchanged,
and the damage figures below have **not** been re-measured since 22 August — run
the first verification query before treating them as current.

---

## Current damage

```
warehouse_carton rows          196
distinct carton codes           56
duplicated codes                33
SURPLUS ROWS                   140
SURPLUS UNITS                7,980
codes on MORE THAN ONE pallet   32
orphaned cartons (batch gone)   10 rows / 216 units
pallets                         32
```

Stock is wrong by roughly **8,000 units**. Every count derived from
`warehouse_carton` is currently unreliable.

---

## 1. A carton is created per PASSAGE, not per CARTON — *the critical one*

Every time an EPC crosses the gate, Nexus `INSERT`s a new `warehouse_carton` row
instead of resolving the EPC to the carton that already exists.

Eight physical boxes from one receiving batch:

```
RB-2026-0005-BSC-358-2616-0001   10 rows   pallets: [42359063, none, 37cbc873]
RB-2026-0005-BSC-358-2616-0002   11 rows   pallets: [42359063, none, 37cbc873]
RB-2026-0005-BSC-358-2616-0003    9 rows   pallets: [42359063, none]
RB-2026-0005-BSC-358-2616-0004    7 rows   pallets: [none]
RB-2026-0005-BSC-359-2616-0001    9 rows   pallets: [42359063, none, 37cbc873]
RB-2026-0005-BSC-359-2616-0002    8 rows   pallets: [none, 37cbc873]
RB-2026-0005-BSC-359-2616-0003    9 rows   pallets: [42359063, none]
RB-2026-0005-BSC-359-2616-0004    9 rows   pallets: [42359063, none]
```

One box is simultaneously on two different pallets AND unassigned. **32 carton
codes are currently in this state.**

### The rule that is missing

Every carton has a unique EPC, and `operations_label_tag` already maps EPC →
carton. On a gate passage, ingest should:

1. resolve **EPC → existing carton**;
2. if that carton is already on a pallet, leave it (or *move* it — one row, updated);
3. create a carton row **only** when the EPC has never been seen.

An EPC arriving twice is the normal case at a doorway — a box re-read, a pallet
passing again, an operator re-running a receipt. It must be idempotent on the
carton, not merely on the event id.

A unique constraint on `warehouse_carton.code` would make this impossible to get
wrong, and the existing duplicates have to be merged before it can be applied.

## 2. Deleting a receiving batch leaves its cartons behind

`operations_receiving_batch` no longer contains `RB-2026-0006`, `RB-2026-0008` or
`RB-2026-0009`, but `warehouse_carton` still holds **10 rows / 216 units** whose
codes belong to them, still `received`/`qc_pass`, still counting as stock.

The batch ref lives inside the carton *code string*
(`RB-2026-0008-BSC-227-...`), so no constraint can enforce the relationship —
which is why this failed silently. Needs a real foreign key with an explicit
`ON DELETE` rule, plus a decision: cascade, or refuse to delete a batch that has
received cartons.

## 3. Please accept the short `palletCode` — `PALLET-G1-001`

**This is a request, and the warehouse wants it.** Earlier drafts of this
document asked what the pattern was; the answer needed is now a change.

```
POST /api/movement
→ 400 {"ok":false,"error":"invalid payload",
       "detail":{"fieldErrors":{"palletCode":["Invalid"]}}}
```

| Pallet code | Length | Nexus today |
| --- | --- | --- |
| `PLT-YIWU-MAIN-GATE-00000526` | 27 | accepted |
| `PALLET-G1-001` | 13 | **400 invalid payload** |

### Why the long form does not work on the floor

The pallet code IS the barcode and the caption on a printed label, and it is what
someone reads aloud over a radio. At 27 characters it does not sit comfortably on
the label, and it cannot be dictated without transcription errors. The short form
exists because that is what the warehouse can actually use.

### The change

Relax the pattern to something like:

```
^[A-Z0-9-]{3,32}$
```

That accepts **both** forms, so nothing already stored becomes invalid and no
migration is required. If a different pattern is preferred, any pattern that
admits `PALLET-G1-001` works — the exact shape is yours to choose, we only need
to know it.

### Why this one blocks

A rejected `palletCode` returns `400`, and `400` is terminal in the bridge's
retry policy — the only response that means "never acceptable", so it is never
retried. Every carton carrying a short code is therefore **dead-lettered**: read
at the door, counted on the board, and permanently refused by the server. That is
exactly what happened when it was last attempted, which is why the bridge was
reverted.

### Bridge side is ready

The format is now a switch (`PALLET_CODE_FORMAT=short|long`, default `long`), so
the changeover is one setting and a restart. Both forms are tested, and gate
uniqueness is preserved — a second gate mints `PALLET-G2-001`.

It stays on `long` until Nexus confirms, because flipping it first stops
receiving completely. The bridge also now names the cause explicitly if it ever
happens again, rather than leaving an operator to work out why cartons are
vanishing:

```
Nexus is rejecting the short pallet code "PALLET-G1-001".
Set PALLET_CODE_FORMAT=long and restart — every carton is being
dead-lettered until you do.
```

**What we need back:** confirmation that the short form is accepted, plus the
exact final pattern. It is documented nowhere the bridge can see, so the bridge
cannot validate against it locally — the first symptom of a mismatch is cartons
quietly going missing.

## 4. No way to reset a gate's ingest ledger

`operations_gate_ingest` keys idempotency on `source_event_id`
(`yiwu-main-gate:4`). When local state is wiped and the sequence restarts, the
new events reuse those IDs with different payloads and Nexus correctly answers:

```
409 {"state":"conflict",
     "error":"eventId yiwu-main-gate:4 already belongs to a different payload"}
```

Delivery is strictly ordered, so **the whole queue stops on the first conflict**
and every later reading silently fails to arrive. The only remedy today is
deleting rows directly in the database.

Mitigated on the bridge — event IDs now carry a generation
(`yiwu-main-gate:g2:1`) that advances on every wipe, so a restarted sequence can
no longer collide. Still worth an endpoint:

```
POST /api/movement/admin/reset
Authorization: Bearer <MOVEMENT_API_KEY>
{ "gateId": "yiwu-main-gate", "confirm": "reset" }

→ { "ok": true, "deleted": { "ingest": 90, "passages": 12 } }
```

Scoped to one `gateId`, never global.

## 5. Cartons created, line not credited

On one run, `operations_receiving_line` stayed at `received=0/4` for both
products while 59 carton rows were created for them. On another, the line read
`4/4` correctly while the cartons duplicated anyway.

Caveat: the bridge was under-reporting pallet contents during some of these runs
(see the bridge-side list above), so part of this may be us. Worth a look only if
it reproduces once the gate is sending correct counts — carton creation and line
crediting disagreeing in either direction suggests they are not one transaction,
but that is a hypothesis, not a confirmed defect.

## 6. Receiving resets are invisible to the gate — please publish a marker

When receiving is reset (on the iPad, or in Nexus), nothing tells the gate. It
currently infers the reset by re-reading the whole receiving list every 60s and
noticing a received count go *backwards*. That works, but it is a minute late,
and during that minute the gate judges cartons against records that no longer
exist — so a redo started immediately after a reset gets the first few cartons
wrong.

### Why the gate must ASK rather than be told

Nexus is on the internet; this bridge is on a warehouse LAN with no inbound
route. Everything the gate already does — pushing movements, reading the board —
goes outward, and so must this. A webhook would need a tunnel; a marker needs
nothing.

### The change

One small read:

```
GET /api/receiving/reset-marker
Authorization: Bearer <MOVEMENT_API_KEY>

→ { "resetAt": "2026-08-24T06:32:11.000Z",   // or "resetSeq": 47
    "epcs": ["E28011AA…", "E28011BB…"],      // cartons the reset undid
    "reason": "batch 4821 reset on iPad" }   // optional, for the log
```

- **`resetAt`** is compared for **equality only**, never parsed as a date. A
  counter, a row id or a hash works just as well — whatever is cheapest.
- **`epcs`** is what makes the reset surgical. With it the gate forgets exactly
  those cartons; without it it must forget every carton it knows, including
  cartons from batches nobody touched.
- Keep the response small: the gate polls it every 5s.

### Bridge side is ready

Built and tested against a stand-in endpoint: it takes a baseline on boot (so a
restart never replays an old reset), acts only when the marker changes, warns
once rather than every 5s if Nexus is unreachable, and suppresses the slower
figure-based detector so one reset is never applied twice. The 60s figure check
stays as the fallback.

## 7. The gate now only ever reports RECEIPTS — and 198 dispatches it sent were guesses

Two parts: a change to what you will receive from now on, and an admission about
what you already received.

### 7a. Payload change — `direction` is now always `in`

The gate's direction logic has been deleted. It previously inferred direction in
no-IR mode by flipping per EPC (first pass in, next pass out), which is a guess
dressed up as an observation. It now answers one question — *is the paperwork
still waiting for this carton?* — and reports a receipt or nothing at all.

| Field | Was | Now |
| --- | --- | --- |
| `type` | `entry` \| `exit` | **always `entry`** |
| `direction` | `in` \| `out` | **always `in`** |
| `unexpected` | `no-open-batch` \| `not-received` \| `already-shipped` \| null | **always `null`** |
| `basis` | `local-flip`, `state-never-received`, `state-shipped-return`, `state-in-building` | `on-open-batch`, `on-open-batch-cached` |

What this means for your ingest:

- Any `direction === 'out' → ship` branch will **never fire** for this gate.
  Not because shipping stopped, but because the gate has no honest way to know a
  carton is leaving: nothing tells it which cartons are on an open shipment.
  Outbound reads are now discarded at the door.
- `unexpected` is kept on the wire but is permanently `null`. What used to be
  reported-and-flagged is now simply not sent. If you have logic reading that
  field, it is inert — not broken, just never true.
- A read the gate declines is counted in its own summary, not sent to you. So
  fewer events overall, and every one that arrives is a carton on an open batch.

Re-enabling shipping needs a source of truth from your side — which cartons are
on an open shipment. Until that exists it stays off (`GATE_ALLOW_SHIPPING`,
default off) rather than being guessed.

### 7b. 198 dispatch events were guesses. Please check for them.

Measured from this gate's journal, `data/movement-log.jsonl`, covering
2026-08-22 12:34 to 2026-08-24 06:19:

```
695  events journalled
497  'entry' / 'in'
198  'exit' / 'out'      <- every one of these was inferred, not observed
463  carried unexpected: 'no-open-batch' (reported anyway, flagged)
```

How many actually reached you:

| Path | Bogus dispatches delivered |
| --- | --- |
| `POST /api/movement` (outbox, delivery cursor at seq 23) | **7** |
| Legacy direct `operations_tag_scan` write | **0** — all events postdate the 2026-08-21 burn-in cutoff |
| **Still queued on the bridge, undelivered** | **191** |

**Resolved on the bridge side, 2026-08-24.** The 191 queued dispatches have been
purged — the whole local queue was cleared, since this is all pre-production test
traffic and the queue was permanently jammed anyway (see below). Nothing further
will arrive from them.

Delivery had been stuck since 2026-08-22 on:

```
503 {"ok":false,"state":"pending","error":"passage resolved to 0 receiving batches"}
```

Which was your ingest answering correctly — the gate was reporting cartons no
open batch expected. A 503 is retryable, and delivery is strictly ordered, so the
queue jammed behind the first one and never moved. Worth knowing as a shape: a
correct refusal of one bad event silently stops every good event behind it.

**No action needed from you on this item.** The 7 already delivered are test
traffic and will go with the rest of the test data being cleared. It is recorded
here because the payload change in 7a is permanent and the cause is worth
keeping visible, not because anything needs repairing.

Also relevant to item 1: those 463 `no-open-batch` events were cartons no open
batch expected, and the gate reported them anyway. Combined with insert-per-
passage they would each have created a carton row. That is now stopped at
source — the gate no longer reports them at all — but it is likely a
contributing cause of the surplus rows, not an unrelated fault.

---

## Faults on the BRIDGE side — not yours, listed for honesty

Nexus can only act on what it is sent, and several of today's symptoms were the
gate sending the wrong thing. These are being fixed at this end and are NOT
requests:

- **A pallet was reported with 5 cartons when 8 were read.** The gate's own
  `carton_count` said 5, so Nexus stored 5 — correctly. Bridge bug: the count was
  taken from the undelivered queue rather than from the passage, so cartons
  already delivered dropped out of it.
- **Short `palletCode` (`PALLET-G1-001`) was sent and rejected.** The bridge
  changed the format without checking your contract. Reverted, and now behind a
  switch. Item 3 above is therefore a *request*, not a defect report — the
  rejection was your validation working correctly.
- **198 dispatch events that were guesses** (item 7b). No-IR direction inference
  flipped each EPC in/out by pass order, so every second visit was reported as a
  shipment. 7 reached you; 191 are still queued here and must be purged. The
  inference is deleted, not tuned — the gate reports receipts or nothing.
- **463 events reported with `unexpected: 'no-open-batch'`.** The gate saw
  cartons no open batch expected and reported them anyway, flagged. Under item 1
  each would have created a carton row. Now they are not reported at all.
- **Event-ID collisions after a local wipe.** The bridge restarted its sequence
  while your ledger remembered the old IDs; the 409s were Nexus protecting
  itself, exactly as designed. Fixed here with a generation counter.

### Why item 1 is still genuinely server-side

The distinction matters. For duplicate cartons the bridge is NOT sending
something wrong: it reports "EPC `BC01…A0` passed inbound", which is true and
unambiguous every time. The EPC is the carton's identity, and the EPC → carton
mapping lives in `operations_label_tag`, which only Nexus can read.

So when the same EPC arrives twice, only Nexus is in a position to know it is
the same box. The bridge cannot tell it — and should not have to, because a box
genuinely can pass the gate twice. That decision, insert-or-match, is entirely
inside the ingest.

Same for item 2: batch deletion involves no bridge traffic at all.

## What is NOT a problem anywhere

- **Delivery.** The bridge journals every event to disk before the network is
  touched, retries indefinitely, and dead-letters only on a terminal 4xx. Nothing
  has been lost at any point today.
- **Duplicate EPCs.** `operations_label_tag` has one row per EPC, no duplicates.

## Verifying the fixes

```sql
-- 1. one row per carton: must return zero rows
select code, count(*) from warehouse_carton group by code having count(*) > 1;

-- 2. no carton on more than one pallet: must return zero rows
select code, count(distinct pallet_id) from warehouse_carton
group by code having count(distinct pallet_id) > 1;

-- 3. no orphans: must return zero rows
select c.code from warehouse_carton c
where not exists (select 1 from operations_receiving_batch b
                  where c.code like b.ref || '-%');
```

End to end: walk the same carton through the gate three times. Expect **one**
carton row, the receiving line to increase by **one**, and the pallet to hold it
**once**.

## Repair before or alongside the fix

1. Merge the 140 surplus carton rows (33 codes), keeping the earliest receipt.
2. Remove the 10 orphaned cartons (216 units).
3. Recompute `received_cartons` / `synced_cartons` / `synced_units` for the
   affected receiving lines.

Code changes stop new damage; they do not correct what is already written.
