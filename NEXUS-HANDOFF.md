# Nexus handoff — gate ingest defects

**From:** RFID gate bridge, Yiwu main gate (`GATE_ID=yiwu-main-gate`)
**Date:** 2026-08-22
**Scope:** everything below is **server-side**. The bridge reports "EPC X passed the
gate"; Nexus decides what that means. None of it is fixable from the doorway.

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

## 3. `palletCode` validation rejects anything but the long form

```
POST /api/movement
→ 400 {"ok":false,"error":"invalid payload",
       "detail":{"fieldErrors":{"palletCode":["Invalid"]}}}
```

Accepted:  `PLT-YIWU-MAIN-GATE-00000526`
Rejected:  `PALLET-G1-001`

Every carton carrying the short code was **dead-lettered** — read by the gate,
counted on the board, refused by the server. The bridge has been reverted to the
long form, so this is not currently blocking.

The long code is unusable on a printed label and unreadable over a radio. If the
pattern can be relaxed to something like `^[A-Z0-9-]{3,32}$`, the bridge can
mint short codes again. **Please confirm the exact accepted pattern** either way
— it is not documented anywhere the bridge can see.

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
  changed the format without checking your contract. Reverted. Item 3 below is a
  *request*, not a defect report.
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
