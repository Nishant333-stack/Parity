#!/usr/bin/env ts-node
//
// Runs one reconciliation pass locally and prints the result — the same
// logic the hourly Lambda runs (src/lib/reconcile.ts), without waiting for
// the schedule. Useful right after triggering test events, or to check
// drift on demand.
//
//   npm run reconcile
//
import { reconcile } from '../src/lib/reconcile';

function money(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  console.log('Reconciling against Stripe’s own balance transactions...\n');
  const result = await reconcile();

  console.log(`  Stripe balance transactions (charge/refund/dispute/payout): ${money(result.stripeCashCents)}`);
  console.log(`  Ledger stripe:cash account:                    ${money(result.ledgerCashCents)}`);
  console.log(`  Drift:                                         ${money(result.driftCents)}`);
  console.log();
  console.log(`  Stranded claims found:   ${result.strandedClaims}`);
  console.log(`  Missing events found:    ${result.missingEvents}`);
  console.log(`  Backfilled:              ${result.backfilled}`);
  console.log(`  Backfill failures:       ${result.backfillFailed}`);
  console.log();

  if (result.driftCents === 0) {
    console.log('Ledger agrees with Stripe. Drift is $0.00.');
  } else {
    console.log(`Ledger DISAGREES with Stripe by ${money(result.driftCents)}.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
