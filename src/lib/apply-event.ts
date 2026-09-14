import type Stripe from 'stripe';
import { execute, param, withTransaction } from './data-api';
import { project } from './projection';

export type ApplyOutcome = 'projected' | 'already_processed' | 'no_entries';

/**
 * Idempotently applies one Stripe event to the ledger: claims the event id,
 * then inserts the transaction and its entries (if any), all inside one
 * Data API transaction. Keyed by Stripe event id, not by anything the caller
 * has to track — see docs/adr/0004-balanced-entries-in-the-database.md.
 *
 * Used by both the live projector (src/handlers/projector.ts) and
 * scripts/rebuild-ledger.ts. That sharing is the point: "rebuild replays
 * through the same projection logic" is true because it's the same
 * function, not a second implementation that can drift from the first.
 */
export async function applyEvent(event: Stripe.Event): Promise<ApplyOutcome> {
  const entries = project(event);

  return withTransaction(async (txId) => {
    const claim = await execute(
      'INSERT INTO processed_events (event_id, event_type) VALUES (:eventId, :eventType) ' +
        'ON CONFLICT (event_id) DO NOTHING',
      [param('eventId', event.id), param('eventType', event.type)],
      txId,
    );
    if (claim.numberOfRecordsUpdated === 0) return 'already_processed';
    if (entries.length === 0) return 'no_entries';

    const txnResult = await execute(
      'INSERT INTO transactions (event_id, event_type) VALUES (:eventId, :eventType) RETURNING id',
      [param('eventId', event.id), param('eventType', event.type)],
      txId,
    );
    const txnId = txnResult.records?.[0]?.[0]?.stringValue;
    if (!txnId) {
      throw new Error(`insert into transactions returned no id for event ${event.id}`);
    }

    for (const entry of entries) {
      await execute(
        'INSERT INTO entries (txn_id, account, amount_cents) VALUES (:txnId, :account, :amountCents)',
        [param('txnId', txnId), param('account', entry.account), param('amountCents', entry.amountCents)],
        txId,
      );
    }

    await execute(
      'UPDATE processed_events SET txn_id = :txnId WHERE event_id = :eventId',
      [param('txnId', txnId), param('eventId', event.id)],
      txId,
    );

    return 'projected';
  });
}
