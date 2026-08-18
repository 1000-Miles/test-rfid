# Nexus handoff — deleting a receiving batch leaves its cartons behind

**Reported as:** "stock in Nexus shows 10 for 5 cartons"
**Diagnosed:** 2026-08-18 from the RFID gate bridge side
**Owner:** Nexus — the gate is not involved (see *Ruled out*)
**Impact:** 10 phantom carton rows, **216 units** of stock that do not exist

---

## Summary

`operations_receiving_batch` currently holds **two** batches: `RB-2026-0001` and
`RB-2026-0002`.

`warehouse_carton` holds rows belonging to **five**: those two plus
`RB-2026-0006`, `RB-2026-0008` and `RB-2026-0009` — batches that no longer exist
in the table at all, not even soft-deleted.

Deleting a receiving batch does not remove, soft-delete, or reverse its cartons.
They stay at `received` / `qc_pass` and keep counting toward stock forever.

## Evidence

```
batch ref in carton code   exists?   cartons   units
RB-2026-0001               LIVE            7     164
RB-2026-0002               LIVE           25    1600
RB-2026-0006               ORPHAN          2      40
RB-2026-0008               ORPHAN          4      88
RB-2026-0009               ORPHAN          4      88
```

The 10 orphans:

```
RB-2026-0006-BSC-229-2616-0001   20u  qc_pass
RB-2026-0006-BSC-229-2616-0002   20u  qc_pass
RB-2026-0008-BSC-227-2616-0001   24u  received   on a pallet
RB-2026-0008-BSC-227-2616-0002   24u  received   on a pallet
RB-2026-0008-BSC-230-2616-0001   20u  received   on a pallet
RB-2026-0008-BSC-230-2616-0002   20u  received   on a pallet
RB-2026-0009-BSC-227-2616-0001   24u  received   on a pallet
RB-2026-0009-BSC-227-2616-0002   24u  received   on a pallet
RB-2026-0009-BSC-230-2616-0001   20u  received   on a pallet
RB-2026-0009-BSC-230-2616-0002   20u  received   on a pallet
```

Two distinct kinds of wrongness, worth separating when repairing:

| | rows | units | meaning |
|---|---:|---:|---|
| Double-counted | 2 | **48** | box also exists in a live batch — same carton counted twice |
| Phantom | 8 | **168** | box exists *only* in a deleted batch — stock for something with no document |

`BSC-227-2616-0002` is the clearest case: it exists three times — once in live
`RB-2026-0001`, and again in deleted `RB-2026-0008` and `RB-2026-0009`.

**8 of the 10 are attached to a pallet** (`pallet_id` set), so they also inflate
pallet contents, not just headline stock.

## The defect

Batch deletion is not transactional with respect to what the batch created.
Whatever removes an `operations_receiving_batch` row must also deal with its
`warehouse_carton` children.

Which behaviour is correct is a product decision:

- **Cascade** — delete/soft-delete the cartons with the batch. Right if a
  deleted batch means "this receipt never happened".
- **Block** — refuse to delete a batch that has received cartons, requiring
  them to be un-received first. Safer: it makes losing stock records impossible
  rather than merely unlikely.
- **Orphan deliberately** — reassign to a holding batch so the stock stays
  visible and reconcilable instead of dangling.

Whichever is chosen, a **foreign key from `warehouse_carton` to the batch** with
an explicit `ON DELETE` rule is what makes it hold. Right now the batch ref is
embedded in the carton *code string* (`RB-2026-0008-BSC-227-...`), which no
constraint can enforce — that is why this was silent.

## Data repair

Code changes do not fix what is already written:

1. Delete (or soft-delete) the 10 orphaned cartons listed above — **216 units**.
2. Re-check pallet contents for the 8 that carry a `pallet_id`.
3. Recompute stock for products **A004227**, **A004229**, **A004230**.
4. `operations_receiving_line` figures looked *correct* throughout
   (`received_cartons` = `synced_cartons`, units = cartons × units-per-carton),
   so the lines likely need no repair — verify rather than assume.

## Ruled out

Recorded so nobody re-treads it:

- **Not the gate.** The orphan rows were created 2 and 6 at a time *within the
  same second* — bulk creation. Gate passages arrive seconds to minutes apart.
- **Not stale RFID labels.** The only EPCs that have ever crossed the gate are
  the current ones (`BC01…0049`, `004A`, `004B`, `004C`). No superseded label
  has ever passed the doorway.
- **Not duplicate EPCs.** `operations_label_tag` has 106 rows and 106 distinct
  EPCs.
- **Not the bridge dual-write.** Burn-in is active, but `operations_tag_scan`
  has one duplicated row today, not a systematic doubling.

## Separate, unrelated risk — multiple live EPCs per box

Verified but **not** the cause of the stock problem. Recording it because it will
bite later.

Reprinting a label mints a new EPC against the same `box_id` and never retires
the old one — every EPC ever issued stays `status = printed`. **8 of 85 boxes**
carry more than one live EPC:

```
BSC-228-2616-0001  6 EPCs      BSC-227-2616-0002  2 EPCs
BSC-229-2616-0001  5 EPCs      BSC-229-2616-0002  2 EPCs
BSC-230-2616-0001  5 EPCs      BSC-230-2616-0002  2 EPCs
BSC-227-2616-0001  5 EPCs      BSC-228-2616-0002  2 EPCs
```

Nothing marks which label is on the box today; the newest `created_at` is the
only signal, and it is implicit. No harm has occurred **yet** because no stale
label has crossed the gate — but the gate keys on EPC, so the first time an old
label goes through it will read as a carton nobody has seen and be received
again.

Fix independently: retire prior labels on reprint (a partial unique index
guaranteeing one live EPC per `box_id` is the durable form).

## Verification

```sql
-- orphaned cartons: must return zero rows
select c.code, c.units, c.status
from warehouse_carton c
where not exists (
  select 1 from operations_receiving_batch b
  where c.code like b.ref || '-%'
);

-- one live label per box: must return zero rows
select box_id, count(*)
from operations_label_tag
where status <> 'superseded'
group by box_id having count(*) > 1;
```

End-to-end: create a receiving batch, receive a carton into it, delete the
batch, and confirm stock returns to its prior value.

## Open question

**How were `RB-2026-0006`, `0008` and `0009` removed?** Through the Nexus UI, an
admin action, or directly against the database? That determines whether this is
a missing cascade in application code or a manual operation that bypassed it —
and it is the difference between a code fix and a process fix.
