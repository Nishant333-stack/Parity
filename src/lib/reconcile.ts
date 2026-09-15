import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type Stripe from 'stripe';
import { applyEvent } from './apply-event';
import { execute, numeric } from './data-api';
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

export interface StrandedClaim {
  readonly eventId: string;
  readonly eventType: string;
  readonly claimedAt: string;
}

export interface ReconciliationResult {
  readonly stripeCashCents: number;
  readonly ledgerCashCents: number;
  readonly driftCents: number;
  readonly strandedClaims: number;
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
 * Known gap: `charge.dispute.created` also books to `stripe:cash`
 * (docs/adr/0002... see projection.ts) but its balance-transaction
 * counterpart (type `adjustment`) isn't included here yet. Documented in
 * docs/walkthrough/03-reconciliation.md rather than silently ignored.
 *
 * Unbounded: walks the account's entire balance transaction history every
 * run. Fine at this project's volume; a real scale-up would need a
 * checkpointed, incremental version instead.
 */
async function stripeCashTotal(): Promise<number> {
  const stripe = await getStripeClient();
  let total = 0;
  for await (const bt of stripe.balanceTransactions.list({ limit: 100 })) {
    if (bt.type === 'charge' || bt.type === 'refund') {
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
 * Rows still CLAIMED well past when a claim should have resolved to
 * ENQUEUED or been released — the signature of the crash window ADR 0003
 * accepts rather than closes with a distributed transaction.
 */
async function findStrandedClaims(): Promise<StrandedClaim[]> {
  const cutoff = new Date(Date.now() - STRANDED_THRESHOLD_MS).toISOString();
  const result = await dynamo.send(
    new ScanCommand({
      TableName: DEDUPE_TABLE,
      FilterExpression: '#s = :claimed AND claimedAt < :cutoff',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':claimed': 'CLAIMED', ':cutoff': cutoff },
    }),
  );
  return (result.Items ?? []).map((item) => ({
    eventId: String(item.pk).replace(/^evt#/, ''),
    eventType: String(item.eventType ?? ''),
    claimedAt: String(item.claimedAt ?? ''),
  }));
}

/**
 * Recovers one stranded claim by fetching the event directly from Stripe's
 * v1 Events API and applying it through the same applyEvent() the live
 * projector uses — not a second implementation of projection logic.
 *
 * v1, not v2 Core Events: ADR 0003 originally named /v2/core/events as the
 * backfill source. Checked against this account directly — /v2/core/events
 * only carries v2-native resources (Money Management etc.) and was empty
 * even after dozens of v1 charge.succeeded events had been triggered.
 * /v1/events carries exactly what this project's event types need. See
 * docs/walkthrough/03-reconciliation.md.
 *
 * The dedupe row is deleted, not marked resolved, after a successful
 * backfill: its job was only ever to prevent a duplicate *enqueue*, and
 * Postgres's own processed_events table (ADR 0004's ON CONFLICT DO NOTHING)
 * is what actually makes a later redelivery of the same event a no-op. The
 * dedupe table is "an optimisation and an audit trail, not the ledger"
 * (ADR 0003) — deleting a stale row doesn't weaken that.
 */
async function backfillStrandedClaim(claim: StrandedClaim): Promise<'backfilled' | 'failed'> {
  try {
    const stripe = await getStripeClient();
    const event = (await stripe.events.retrieve(claim.eventId)) as Stripe.Event;
    await applyEvent(event);
    await dynamo.send(new DeleteCommand({ TableName: DEDUPE_TABLE, Key: { pk: `evt#${claim.eventId}` } }));
    return 'backfilled';
  } catch {
    return 'failed';
  }
}

/**
 * The hourly job: recover what can be recovered, then measure what's left.
 * Backfilling before measuring means a claim resolved in this same run
 * already counts toward closing the drift it would otherwise have caused.
 */
export async function reconcile(): Promise<ReconciliationResult> {
  const stranded = await findStrandedClaims();

  let backfilled = 0;
  let backfillFailed = 0;
  for (const claim of stranded) {
    const outcome = await backfillStrandedClaim(claim);
    if (outcome === 'backfilled') backfilled++;
    else backfillFailed++;
  }

  const [stripeCashCents, ledgerCashCents] = await Promise.all([stripeCashTotal(), ledgerCashTotal()]);

  return {
    stripeCashCents,
    ledgerCashCents,
    driftCents: stripeCashCents - ledgerCashCents,
    strandedClaims: stranded.length,
    backfilled,
    backfillFailed,
  };
}
