# Nexus handoff — one box, many EPCs → duplicated cartons and stock

**Reported as:** "stock in Nexus shows 10 for 5 cartons"
**Diagnosed:** 2026-08-18, from the RFID gate bridge side
**Owner:** Nexus — the bridge cannot fix this (see *Why not the bridge*)

---

## Summary

Reprinting a carton label mints a **new EPC against the same `box_id`**, and the
previous label is never retired. Every EPC ever issued for a box remains
`status = printed`, so downstream there is nothing to distinguish the current
label from four obsolete ones.

The gate ingest keys on **EPC**, so each stale label that crosses the doorway
looks like a carton nobody has seen before and gets received again — into
whichever batch happens to be open.

One physical box therefore becomes several cartons, and the stock figure
multiplies accordingly.

## Evidence

Every EPC ever issued for a single box, all still live:

```
box BSC-227-2616-0001   product A004227
  BC0100000000000000000001   2026-08-07   status=printed
  BC010000000000000000003D   2026-08-13   status=printed
  BC0100000000000000000041   2026-08-13   status=printed
  BC0100000000000000000045   2026-08-14   status=printed
  BC0100000000000000000049   2026-08-17   status=printed   <- current label
```

Nothing in the row says which one is on the box today. The newest `created_at`
is the only signal, and it is implicit.

**Scope: 8 of 85 boxes** carry more than one live EPC.

| box_id | product | live EPCs | current EPC |
|---|---|---:|---|
| BSC-228-2616-0001 | A004228 | 6 | `BC01…0051` |
| BSC-229-2616-0001 | A004229 | 5 | `BC01…004D` |
| BSC-230-2616-0001 | A004230 | 5 | `BC01…004B` |
| BSC-227-2616-0001 | A004227 | 5 | `BC01…0049` |
| BSC-227-2616-0002 | A004227 | 2 | `BC01…004A` |
| BSC-229-2616-0002 | A004229 | 2 | `BC01…004E` |
| BSC-230-2616-0002 | A004230 | 2 | `BC01…004C` |
| BSC-228-2616-0002 | A004228 | 2 | `BC01…0050` |

Full stale-EPC lists are in the appendix.

### Damage already written

`warehouse_carton` holds the same physical box in multiple receiving batches:

```
BSC-227-2616-0002   3 rows   24 units each   RB-2026-0008, RB-2026-0009, RB-2026-0001
BSC-230-2616-0001   2 rows   20 units each   RB-2026-0009, RB-2026-0008
BSC-227-2616-0001   2 rows   24 units each   RB-2026-0009, RB-2026-0008
BSC-230-2616-0002   2 rows   20 units each   RB-2026-0009, RB-2026-0008
```

**Over-count: 5 surplus carton rows, 112 surplus units.**

## Two defects

### 1. Reprint does not retire the previous label — *the fix that stops recurrence*

Minting a new EPC for an existing `box_id` must mark every earlier row for that
box as superseded. Options, in order of preference:

- a `superseded` / `replaced_by` status on `operations_label_tag`, or
- a `current boolean` / partial unique index guaranteeing **one live EPC per
  `box_id`**.

A unique constraint is the durable answer: it makes the invariant impossible to
violate rather than merely intended. The data already violates it, so it needs
backfilling first (newest per box wins).

### 2. Gate ingest keys on EPC rather than box

`recordGateMovementCore` treats an unseen EPC as a new carton. It should resolve
EPC → `box_id` → existing carton, so a re-labelled box **updates** rather than
creating a second record.

Even with (1) fixed, this is worth doing: it is the layer that turns a stale
label into duplicated stock, and it should refuse to do that regardless of how
clean the registry is.

Suggested behaviour for a scan on a stale EPC: resolve to the box, credit the
existing carton, and report the label as obsolete so the tag can be re-encoded.

## Data repair

Fixing the code does not correct what is already written. Both are needed:

1. Backfill `operations_label_tag` — newest EPC per `box_id` stays live, the
   other 24 EPCs across those 8 boxes are marked superseded.
2. Merge the 5 duplicate `warehouse_carton` rows, keeping the earliest receipt.
3. Recompute `operations_receiving_line.received_cartons` / `synced_cartons` /
   `synced_units` for the affected batches — `RB-2026-0008`, `RB-2026-0009`,
   `RB-2026-0001`, products A004227 / A004230.

## Why not the bridge

The bridge reports *"EPC X passed the gate, inbound"* and nothing more. The
EPC → box mapping lives only in `operations_label_tag`, which Nexus owns.

Verified: this repository contains **no write** to that table — the sole
reference is a `GET` in `bridge/src/passage.js:137`. The printer flow's own note
records the split: *"Nexus marks the cartons printed."* The bridge sends ZPL to a
printer; Nexus mints the EPC and writes the row.

A bridge-side mitigation is possible — treat only the newest EPC per `box_id` as
live and flag the rest — but it would mean the bridge reading Nexus's data to
second-guess Nexus, and it cannot repair existing rows. Worth doing only if the
Nexus fix will be delayed.

## Verifying the fix

```sql
-- must return zero rows once (1) is fixed and backfilled
select box_id, count(*)
from operations_label_tag
where status not in ('superseded')
group by box_id having count(*) > 1;

-- must return zero rows once (2) is fixed and duplicates merged
select regexp_replace(code, '^.*-(BSC-.*)$', '\1') as box, count(*)
from warehouse_carton
group by 1 having count(*) > 1;
```

End-to-end check: reprint a label for a box already received, walk it through
the gate, and confirm `received_cartons` does **not** increase.

## Appendix — stale EPCs to supersede

```
BSC-228-2616-0001  BC01…0033, BC01…0040, BC01…0044, BC01…0048, BC01…004F
BSC-229-2616-0001  BC01…0029, BC01…003F, BC01…0043, BC01…0047
BSC-230-2616-0001  BC01…001F, BC01…003E, BC01…0042, BC01…0046
BSC-227-2616-0001  BC01…0001, BC01…003D, BC01…0041, BC01…0045
BSC-227-2616-0002  BC01…0002
BSC-229-2616-0002  BC01…002A
BSC-230-2616-0002  BC01…0020
BSC-228-2616-0002  BC01…0034
```

*(EPCs are 24 hex chars, prefix `BC01` + zeros; abbreviated above by the final
digits. Full values: query `operations_label_tag` by `box_id`.)*
