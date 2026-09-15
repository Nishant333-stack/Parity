import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  type Field,
  RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';
import { getSecret } from './secrets';

const client = new RDSDataClient({});

// These env vars hold SSM *paths*, not values — the cluster isn't a CDK
// resource (see lib/constructs/ledger.ts), so its ARN and Data API secret
// aren't known until scripts/create-ledger-cluster.sh writes them to SSM.
// Resolved once per execution environment, same caching as Stripe secrets.
const CLUSTER_ARN_PARAM = process.env.LEDGER_CLUSTER_ARN_PARAM!;
const SECRET_ARN_PARAM = process.env.LEDGER_SECRET_ARN_PARAM!;
const DATABASE_PARAM = process.env.LEDGER_DATABASE_PARAM!;

interface Identity {
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly database: string;
}

let identity: Identity | undefined;

async function resolveIdentity(): Promise<Identity> {
  if (!identity) {
    const [resourceArn, secretArn, database] = await Promise.all([
      getSecret(CLUSTER_ARN_PARAM),
      getSecret(SECRET_ARN_PARAM),
      getSecret(DATABASE_PARAM),
    ]);
    identity = { resourceArn, secretArn, database };
  }
  return identity;
}

export type SqlValue = string | number | bigint | boolean | null;

function toField(value: SqlValue): Field {
  if (value === null) return { isNull: true };
  if (typeof value === 'boolean') return { booleanValue: value };
  // Cents amounts in this project stay well inside Number's safe integer
  // range; a bigint here is about signed-arithmetic intent, not magnitude.
  if (typeof value === 'bigint') return { longValue: Number(value) };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
  }
  return { stringValue: value };
}

export function param(name: string, value: SqlValue): SqlParameter {
  return { name, value: toField(value) };
}

/**
 * Postgres's SUM(bigint) returns numeric, not bigint (bigint could overflow
 * on a huge sum), and the Data API serializes numeric as stringValue, not
 * longValue — reading only longValue silently produces 0 for every summed
 * column instead of erroring. Normalizes across long/double/numeric-as-string.
 */
export function numeric(field: Field | undefined): number {
  if (!field) return 0;
  if (field.longValue !== undefined) return field.longValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.stringValue !== undefined) return Number(field.stringValue);
  return 0;
}

export interface ExecuteResult {
  readonly records?: Field[][];
  readonly numberOfRecordsUpdated?: number;
}

export async function execute(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
): Promise<ExecuteResult> {
  const { resourceArn, secretArn, database } = await resolveIdentity();
  const result = await client.send(
    new ExecuteStatementCommand({
      resourceArn,
      secretArn,
      database,
      sql,
      parameters,
      transactionId,
    }),
  );
  return { records: result.records, numberOfRecordsUpdated: result.numberOfRecordsUpdated };
}

/**
 * Runs `fn` inside a Data API transaction and commits on success.
 *
 * The balance constraint trigger is `DEFERRABLE INITIALLY DEFERRED`, so it
 * fires at commit, not at the INSERT that would naively seem to violate it.
 * That means an unbalanced journal entry fails here, at CommitTransaction —
 * not at execute() — and this is the only place that failure can surface.
 */
export async function withTransaction<T>(fn: (transactionId: string) => Promise<T>): Promise<T> {
  const { resourceArn, secretArn, database } = await resolveIdentity();

  const begin = await client.send(new BeginTransactionCommand({ resourceArn, secretArn, database }));
  const transactionId = begin.transactionId;
  if (!transactionId) throw new Error('BeginTransaction returned no transactionId');

  let result: T;
  try {
    result = await fn(transactionId);
  } catch (err) {
    await rollback(resourceArn, secretArn, transactionId);
    throw err;
  }

  try {
    await client.send(new CommitTransactionCommand({ resourceArn, secretArn, transactionId }));
  } catch (err) {
    await rollback(resourceArn, secretArn, transactionId);
    throw err;
  }

  return result;
}

async function rollback(resourceArn: string, secretArn: string, transactionId: string): Promise<void> {
  // Best-effort: if commit already failed, Postgres has typically already
  // aborted the transaction server-side and this may itself error — that's
  // fine, the original failure is what the caller needs to see.
  await client
    .send(new RollbackTransactionCommand({ resourceArn, secretArn, transactionId }))
    .catch(() => {});
}
