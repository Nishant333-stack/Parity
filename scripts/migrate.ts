#!/usr/bin/env ts-node
//
// Applies db/schema.sql to the deployed ledger cluster via the RDS Data API.
// Idempotent — every statement is CREATE ... IF NOT EXISTS or CREATE OR
// REPLACE, so re-running after any failure just re-applies cleanly.
//
// Requires LEDGER_CLUSTER_ARN, LEDGER_SECRET_ARN, LEDGER_DATABASE in the
// environment (scripts/migrate.sh reads them from the stack outputs).
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { execute } from '../src/lib/data-api';

async function main(): Promise<void> {
  const sqlPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const raw = readFileSync(sqlPath, 'utf8');

  const statements = raw
    .split(/^-- @statement\s*$/m)
    .slice(1)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length === 0) {
    throw new Error(`no "-- @statement" blocks found in ${sqlPath}`);
  }

  console.log(`applying ${statements.length} statement(s) from db/schema.sql`);

  for (const [i, sql] of statements.entries()) {
    const label = sql.split('\n')[0].slice(0, 60);
    process.stdout.write(`  [${i + 1}/${statements.length}] ${label}... `);
    await execute(sql);
    console.log('ok');
  }

  console.log('schema up to date');
}

main().catch((err) => {
  console.error(`\nFAILED: ${(err as Error).message}`);
  process.exit(1);
});
