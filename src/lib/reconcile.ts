import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type Stripe from 'stripe';
import { applyEvent } from './apply-event';
import { execute, numeric, param } from './data-api';
import { getStripeClient } from './stripe-client';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const DEDUPE_TABLE = process.env.DEDUPE_TABLE!;

/**
 * How long a CLAIMED row may sit with no matching ledger entry before it's
 * treated as stranded rather than merely in flight. ADR 0003's residual
 * crash window is the process being killed between claim and enqueue — that
 * resolves in milliseconds, not minutes, so 15 minutes is generous headroom
 * against a slow cold start, not a tuned SLA.
 */
const STRANDED_THRESHOLD_MS = 15 * 60 * 1000;

/** Event types project() books, and therefore the only ones worth diffing against Stripe. */
const LEDGER_EVENT_TYPES = ['charge.succeeded', 'charge.refunded', 'charge.dispute.created'] as const;

export interface ReconciliationResult {
  readonly stripeCashCents: number;
  readonly ledgerCashCents: number;
  readonly driftCents: number;
  readonly strandedClaims: number;
  readonly missingEvents: number;
  readonly backfilled: number;
  readonly backfillFailed: number;
}

/**
 * Sums Stripe's own record of cash movement for charges and refunds — the
 * same two event types project() books to `stripe:cash` (src/lib/projection.ts).
 * Balance transaction `amount` is gross and signed (positive for a charge,
 * negative for a refund), matching this project's booking convention exactly;
 * `net` (amount minus Stripe's fee) does not, since fees aren't modeled as a
 * ledger account here. Compare against `amount`, not `net`, or every run
 * reports "drift" that is actually just unbooked fees.
 *
 * `charge.dispute.created` also books to `stripe:cash` (see projection.ts),
 * and its balance-transaction counterpart is included via
 * `reporting_category === 'dispute'` — Stripe's own field for exactly this
 * grouping, and more precise than filtering on `type === 'adjustment'`,
 * which also covers non-dispute adjustments (e.g. reserve changes) that
 * project() never books and would introduce phantom drift if summed here.
 *
 * Unbounded: walks the account's entire balance transaction history every
 * run. Fine at this project's volume; a real scale-up would need a
 * checkpointed, incremental version instead.
 */
async function stripeCashTotal(): Promise<number> {
  const stripe = await getStripeClient();
  let total = 0;
  for await (const bt of stripe.balanceTransactions.list({ limit: 100 })) {
    if (bt.type === 'charge' || bt.type === 'refund' || bt.reporting_category === 'dispute') {
      total += bt.amount;
    }
  }
  return total;
}

async function ledgerCashTotal(): Promise<number> {
  const result = await execute("SELECT COALESCE(SUM(amount_cents), 0) FROM entries WHERE account = 'stripe:cash'");
  return numeric(result.records?.[0]?.[0]);
}

/**
 * Recovers one event by applying it through the same applyEvent() the live
 * projector uses — not a second implementation of projection logic. Safe to
 * call on an event that's already been applied: applyEvent() is idempotent
 * by construction (ADR 0004's ON CONFLICT DO NOTHING), so the two recovery
 * passes below (findStrandedClaims and findMissingLedgerEvents) can overlap
 * on an event without any coordination between them.
 *
 * v1, not v2 Core Events: ADR 0003 originally named /v2/core/events as the
 * backfill source. Checked against this account directly — /v2/core/events
 * only carries v2-native resources (Money Management etc.) and was empty
 * even after dozens of v1 charge.succeeded events had been triggered.
 * /v1/events carries exactly what this project's event types need. See
 * docs/walkthrough/03-reconciliation.md.
 */
async function backfillEvent(event: Stripe.Event): Promise<'backfilled' | 'failed'> {
  try {
    await applyEvent(event);
    return 'backfilled';
  } catch {
    return 'failed';
  }
}

/**
 * Pass 1 — the fast, targeted signal: rows still CLAIMED well past when a
 * claim should have resolved to ENQUEUED or been released. This is exactly
 * the crash window ADR 0003 names and accepts rather than closes with a
 * distributed transaction. The row is deleted, not marked resolved, once
 * recovered: its only job was preventing a duplicate *enqueue*, and
 * Postgres's own processed_events table (ADR 0004) is what actually makes a
 * later redelivery a no-op — the dedupe table is "an optimisation and an
 * audit trail, not the ledger" (ADR 0003).
 */
async function recoverStrandedClaims(): Promise<{ found: number; backfilled: number; failed: number }> {
  const cutoff = new Date(Date.now() - STRANDED_THRESHOLD_MS).toISOString();
  const result = await dynamo.send(
    new ScanCommand({
      TableName: DEDUPE_TABLE,
      FilterExpression: '#s = :claimed AND claimedAt < :cutoff',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':claimed': 'CLAIMED', ':cutoff': cutoff },
    }),
  );
  const rows = result.Items ?? [];

  const stripe = await getStripeClient();
  let backfilled = 0;
  let failed = 0;
  for (const row of rows) {
    const eventId = String(row.pk).replace(/^evt#/, '');
    try {
      const event = (await stripe.events.retrieve(eventId)) as Stripe.Event;
      const outcome = await backfillEvent(event);
      if (outcome === 'backfilled') {
        backfilled++;
        await dynamo.send(new DeleteCommand({ TableName: DEDUPE_TABLE, Key: { pk: `evt#${eventId}` } })).catch(() => {});
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
  }
  return { found: rows.length, backfilled, failed };
}

/**
 * Pass 2 — the complete check: every ledger-relevant event Stripe has ever
 * sent, diffed directly against processed_events, not against DynamoDB's
 * claim state at all.
 *
 * Why this exists alongside recoverStrandedClaims(): a stranded claim only
 * happens for an event that got PAST signature verification and WAS
 * claimed. An event that never reached that point — rejected at
 * verification because the wrong webhook secret was active, for
 * instance — leaves no DynamoDB row of any kind, so pass 1 cannot see it.
 * Found exactly this running against this project's own history: two real
 * charge.succeeded events from a period when two webhook endpoints existed
 * and half of deliveries failed signature verification (CLAUDE.md's Known
 * noise). processed_events, not DynamoDB, is the actual source of truth for
 * "has this event been applied" (ADR 0004) — comparing against it directly
 * catches that gap and any other reason an event never arrived, not only
 * the one ADR 0003 named.
 *
 * Unbounded, same tradeoff as stripeCashTotal(): walks all of Stripe's
 * history for these event types every run.
 */
async function recoverMissingLedgerEvents(): Promise<{ found: number; backfilled: number; failed: number }> {
  const stripe = await getStripeClient();
  const candidates: Stripe.Event[] = [];
  for (const type of LEDGER_EVENT_TYPES) {
    for await (const event of stripe.events.list({ type, limit: 100 })) {
      candidates.push(event);
    }
  }
  if (candidates.length === 0) return { found: 0, backfilled: 0, failed: 0 };

  const result = await execute(
    `SELECT event_id FROM processed_events WHERE event_id IN (${candidates.map((_, i) => `:id${i}`).join(', ')})`,
    candidates.map((event, i) => param(`id${i}`, event.id)),
  );
  const known = new Set((result.records ?? []).map((row) => row[0]?.stringValue));
  const missing = candidates.filter((event) => !known.has(event.id));

  let backfilled = 0;
  let failed = 0;
  for (const event of missing) {
    const outcome = await backfillEvent(event);
    if (outcome === 'backfilled') backfilled++;
    else failed++;
  }
  return { found: missing.length, backfilled, failed };
}

/**
 * The hourly job: recover what can be recovered, then measure what's left.
 * Backfilling before measuring means an event resolved in this same run
 * already counts toward closing the drift it would otherwise have caused.
 */
export async function reconcile(): Promise<ReconciliationResult> {
  const [stranded, missing] = await Promise.all([recoverStrandedClaims(), recoverMissingLedgerEvents()]);

  const [stripeCashCents, ledgerCashCents] = await Promise.all([stripeCashTotal(), ledgerCashTotal()]);

  return {
    stripeCashCents,
    ledgerCashCents,
    driftCents: stripeCashCents - ledgerCashCents,
    strandedClaims: stranded.found,
    missingEvents: missing.found,
    backfilled: stranded.backfilled + missing.backfilled,
    backfillFailed: stranded.failed + missing.failed,
  };
}
