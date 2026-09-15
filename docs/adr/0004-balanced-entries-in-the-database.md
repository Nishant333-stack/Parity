# ADR 0004 — Balanced entries, enforced in the database

**Status:** accepted · **Date:** 2026-09-15

## Context

A double-entry ledger's core promise is that every transaction balances:
the entries it produces sum to zero. If that promise is only ever
*true because the code that writes entries happens to be correct*, it isn't
a promise — it's an observation that nothing has gone wrong yet. The
question this ADR settles is where that promise is enforced, because that
choice determines whether "unbalanced" is impossible or merely unlikely.

Money here is signed integer cents. No floats — summing thousands of
floating-point entries drifts, and a ledger that can't say with certainty
whether a sum is exactly zero has no business calling itself balanced. No
mutable balance column, either: a balance is always `SUM(amount_cents)`
over immutable entries, computed, not stored. That framing is what makes
"balanced" a single equality check instead of something that needs paired
debit/credit columns to reconcile against each other.

## The wrong answers, and specifically why each one is wrong

**Validate in the application before inserting.** The obvious first
instinct: sum the entries in `src/lib/projection.ts` or the handler, throw
if they don't add to zero. This works for exactly as long as every writer
remembers to call the validator. A future backfill script, an emergency
manual correction, a second projector added in Week 6 — none of them are
required to go through the same code path, and "impossible" has to hold at
the boundary every writer passes through, not at the boundary the one
writer that exists today happens to pass through. Application-level
validation is a guarantee about the code, not about the data.

**A row-level `CHECK` constraint.** Postgres evaluates a `CHECK` against
the row being written, in isolation. It has no way to see the other rows in
the same transaction, so it structurally cannot express "these N rows sum
to zero" — only things true of one row alone, like `amount_cents <> 0`.

**An immediate (non-deferred) constraint trigger.** Closer, but still
wrong: `AFTER INSERT ... FOR EACH ROW` with default (immediate) timing
fires the moment each row is written, before the transaction commits — but
also before the *other* rows in that same transaction have necessarily been
written yet. Inserting a two-row balanced entry would have the first row
evaluated while it's still alone, see a nonzero sum, and reject a
transaction that was never actually going to be unbalanced. An immediate
trigger can't do any better than the `CHECK` it's replacing; it just moves
where the same limitation lives.

## Decision

A **deferrable constraint trigger**, deferred to commit:

```sql
CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_txn_balanced();
```

`assert_txn_balanced()` sums `amount_cents` for the affected `txn_id` and
raises unless the total is exactly zero. `DEFERRABLE INITIALLY DEFERRED` is
the whole mechanism: the trigger still fires once per affected row, but not
until the transaction is about to commit — by which point every row that
transaction touched is visible to the `SUM`. That deferral is what makes it
possible to insert a multi-row journal entry *at all*; an immediate version
of the identical trigger rejects the first row of every transaction, which
is the same failure the row-level `CHECK` has.

`FOR EACH ROW` fires on every affected row, and `AFTER INSERT OR UPDATE OR
DELETE` covers all three — a correction that deletes or amends existing
entries is checked exactly as strictly as the original insert. Nothing
about the constraint is specific to the projector's own write pattern.

## Consequences

- **An unbalanced transaction cannot be committed, from any writer,
  including ones that don't exist yet.** This is the actual content of
  "impossible rather than unlikely" — see
  `scripts/test-balance-constraint.ts`, which proves it by trying, against
  the real deployed database, and asserting the rejection.
- **A transaction with zero entries is trivially balanced** —
  `COALESCE(SUM(...), 0) = 0` over an empty set is `0 = 0`. This isn't a
  special case carved out anywhere; it falls out of the aggregate directly,
  and it's what lets `payment_intent.succeeded` /
  `payment_intent.payment_failed` be recorded in `processed_events` (for
  idempotency) without a `transactions` row, with no branch in the trigger
  to account for it.
- **The deferred trigger re-sums once per affected row.** A two-row
  transaction runs the same `SUM` query twice at commit — redundant work,
  traded deliberately for the ability to insert more than one row in a
  transaction at all. Transactions here are two or three rows; this cost is
  not the kind of thing that shows up.
- **Balanced is necessary, not sufficient.** The trigger guarantees
  internal consistency — the entries this system wrote agree with each
  other — not that the *amounts* are correct. A transaction that books
  $0.98 against a $0.99 charge is still balanced. Catching that class of
  error is what the reconciler (Week 5) is for: it compares the ledger
  against Stripe's own `balance_transactions`, which is the only source
  that can say what the amount *should have been*. This constraint and that
  reconciler check different things and neither substitutes for the other.

## The interview answer

"Balanced by construction" is marketing until someone has actually tried to
violate it and watched the database refuse — which is why the test that
matters here isn't a unit test of the projection logic, it's an integration
test that attempts a real unbalanced write against the real deployed
cluster. The design decision worth explaining isn't "use a constraint
trigger" — it's *deferred, not immediate*. An immediate constraint trigger
is a strictly worse `CHECK` constraint wearing a disguise: it still only
ever evaluates one row's-eye view of the world. Deferring to commit is the
specific mechanism that turns "these rows, together, sum to zero" from a
sentence a row-level constraint cannot express into one the database
enforces — and the price for that is one redundant aggregate query per row,
paid gladly. The other half of the honest answer is the boundary: balanced
means self-consistent, not correct, and pretending otherwise is exactly the
kind of overclaim that a reconciler comparing against Stripe's own books
exists to catch.
