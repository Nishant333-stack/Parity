#!/usr/bin/env ts-node
//
// Prints a point-in-time snapshot of the whole Parity system as JSON.
// Read-only. The actual gathering logic lives in src/lib/system-snapshot.ts,
// shared with the public dashboard's /api/snapshot route
// (src/handlers/dashboard.ts) — one implementation, not two.
//
// Requires the same environment as the other ledger scripts:
// LEDGER_CLUSTER_ARN_PARAM, LEDGER_SECRET_ARN_PARAM, LEDGER_DATABASE_PARAM
// (scripts/dashboard-snapshot.sh sets these), plus AWS_PROFILE/AWS_REGION.
import { getSystemSnapshot } from '../src/lib/system-snapshot';

getSystemSnapshot()
  .then((snapshot) => {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
  })
  .catch((err) => {
    console.error(`FAILED: ${(err as Error).message}`);
    process.exit(1);
  });
