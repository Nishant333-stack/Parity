-- Parity ledger schema.
--
-- Money is signed integer cents, never a float, never a mutable balance
-- column. A balance is always a sum over immutable entries, and the sum for
-- any one transaction is enforced to be exactly zero by the database, not by
-- application code. See docs/adr/0004-balanced-entries-in-the-database.md.
--
-- Applied via the RDS Data API (scripts/migrate.ts), not psql — this cluster
-- has no network path except the Data API. Statements are separated by the
-- `-- @statement` marker so the migration runner can send them one at a
-- time: PL/pgSQL bodies can't share a single Data API ExecuteStatement call
-- with other statements.

-- @statement
CREATE TABLE IF NOT EXISTS transactions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   text NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- @statement
CREATE TABLE IF NOT EXISTS entries (
  id           bigserial PRIMARY KEY,
  txn_id       uuid    NOT NULL REFERENCES transactions(id),
  account      text    NOT NULL,
  amount_cents bigint  NOT NULL CHECK (amount_cents <> 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- @statement
CREATE INDEX IF NOT EXISTS entries_txn_id_idx ON entries (txn_id);

-- @statement
CREATE INDEX IF NOT EXISTS entries_account_idx ON entries (account);

-- One row per Stripe event id, recorded in the same transaction as the
-- entries it produces (or with txn_id left NULL for an event type that books
-- no money movement). This is what makes the projector idempotent: a replay
-- hits the primary key and is a no-op, keyed by Stripe event id, not by
-- anything the application has to compute.
-- @statement
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     text PRIMARY KEY,
  event_type   text NOT NULL,
  txn_id       uuid REFERENCES transactions(id),
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- A row-level CHECK cannot express "these rows sum to zero" — it only ever
-- sees one row. A deferrable constraint trigger can: it fires once per
-- affected row but not until commit, by which point every row the
-- transaction touched is visible to the SUM. That deferral is what lets a
-- multi-row journal entry be inserted at all; an immediate (non-deferred)
-- version of this trigger would reject the first row of every transaction.
-- @statement
CREATE OR REPLACE FUNCTION assert_txn_balanced() RETURNS trigger AS $$
DECLARE
  affected_txn uuid;
  total        bigint;
BEGIN
  affected_txn := COALESCE(NEW.txn_id, OLD.txn_id);

  SELECT COALESCE(SUM(amount_cents), 0) INTO total
  FROM entries
  WHERE txn_id = affected_txn;

  IF total <> 0 THEN
    RAISE EXCEPTION 'transaction % is not balanced: entries sum to % cents, not 0',
      affected_txn, total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- @statement
DROP TRIGGER IF EXISTS entries_balanced ON entries;

-- @statement
CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT OR UPDATE OR DELETE ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_txn_balanced();
