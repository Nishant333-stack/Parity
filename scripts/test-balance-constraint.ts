#!/usr/bin/env ts-node
//
// The project's central claim: an unbalanced journal entry is impossible,
// not just unlikely, because the database rejects it. This proves that by
// trying it against the deployed cluster.
//
// Two checks:
//   1. an unbalanced transaction (one entry, no offset) must be rejected —
//      by CommitTransaction, since the constraint trigger is deferred
//   2. a balanced transaction (two offsetting entries) must succeed — a
//      positive control, so a "PASS" on (1) can't be hiding a broken harness
//
// Requires LEDGER_CLUSTER_ARN, LEDGER_SECRET_ARN, LEDGER_DATABASE in the
// environment (scripts/test-balance-constraint.sh reads them from stack
// outputs).
import { randomUUID } from 'node:crypto';
import { execute, param, withTransaction } from '../src/lib/data-api';

let failed = false;

function pass(msg: string): void {
  console.log(`  PASS  ${msg}`);
}

function fail(msg: string): void {
  console.log(`  FAIL  ${msg}`);
  failed = true;
}

async function insertTransaction(eventId: string, eventType: string, txId: string): Promise<string> {
  const result = await execute(
    'INSERT INTO transactions (event_id, event_type) VALUES (:eventId, :eventType) RETURNING id',
    [param('eventId', eventId), param('eventType', eventType)],
    txId,
  );
  const id = result.records?.[0]?.[0]?.stringValue;
  if (!id) throw new Error('insert into transactions returned no id');
  return id;
}

async function insertEntry(txnId: string, account: string, amountCents: bigint, txId: string): Promise<void> {
  await execute(
    'INSERT INTO entries (txn_id, account, amount_cents) VALUES (:txnId, :account, :amountCents)',
    [param('txnId', txnId), param('account', account), param('amountCents', amountCents)],
    txId,
  );
}

async function testUnbalancedRejected(): Promise<void> {
  console.log('unbalanced entry — must be rejected');
  const eventId = `evt_test_unbalanced_${randomUUID()}`;

  try {
    await withTransaction(async (txId) => {
      const txnId = await insertTransaction(eventId, 'test.unbalanced', txId);
      // One leg only: sums to 100, not 0. No offsetting entry.
      await insertEntry(txnId, 'test:unbalanced', 100n, txId);
    });
    fail('commit succeeded — an unbalanced transaction was accepted');
  } catch (err) {
    const message = (err as Error).message ?? '';
    if (/not balanced/i.test(message)) {
      pass(`rejected at commit — ${message}`);
    } else {
      fail(`rejected, but not for the expected reason — ${message}`);
    }
  }
}

async function testBalancedAccepted(): Promise<void> {
  console.log('\nbalanced entry — must be accepted (positive control)');
  const eventId = `evt_test_balanced_${randomUUID()}`;
  let txnId: string | undefined;

  try {
    await withTransaction(async (txId) => {
      txnId = await insertTransaction(eventId, 'test.balanced', txId);
      await insertEntry(txnId!, 'test:a', 250n, txId);
      await insertEntry(txnId!, 'test:b', -250n, txId);
    });
    pass('committed');
  } catch (err) {
    fail(`a balanced transaction was rejected — ${(err as Error).message}`);
    return;
  }

  // Clean up the control row so repeated test runs don't accumulate fake
  // ledger data. Deleting is itself a transaction the trigger must accept:
  // removing both entries together still sums to zero.
  if (txnId) {
    await withTransaction(async (txId) => {
      await execute('DELETE FROM entries WHERE txn_id = :txnId', [param('txnId', txnId!)], txId);
      await execute('DELETE FROM transactions WHERE id = :txnId', [param('txnId', txnId!)], txId);
    });
  }
}

async function main(): Promise<void> {
  await testUnbalancedRejected();
  await testBalancedAccepted();

  console.log();
  if (failed) {
    console.log('Balance constraint NOT verified.');
    process.exit(1);
  }
  console.log('Balance constraint verified: unbalanced entries are rejected by the database.');
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
