import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  type Field,
  RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
} from '@aws-sdk/client-rds-data';

const client = new RDSDataClient({});

const RESOURCE_ARN = process.env.LEDGER_CLUSTER_ARN!;
const SECRET_ARN = process.env.LEDGER_SECRET_ARN!;
const DATABASE = process.env.LEDGER_DATABASE!;

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

export interface ExecuteResult {
  readonly records?: Field[][];
  readonly numberOfRecordsUpdated?: number;
}

export async function execute(
  sql: string,
  parameters: SqlParameter[] = [],
  transactionId?: string,
): Promise<ExecuteResult> {
  const result = await client.send(
    new ExecuteStatementCommand({
      resourceArn: RESOURCE_ARN,
      secretArn: SECRET_ARN,
      database: DATABASE,
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
  const begin = await client.send(
    new BeginTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, database: DATABASE }),
  );
  const transactionId = begin.transactionId;
  if (!transactionId) throw new Error('BeginTransaction returned no transactionId');

  let result: T;
  try {
    result = await fn(transactionId);
  } catch (err) {
    await rollback(transactionId);
    throw err;
  }

  try {
    await client.send(
      new CommitTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, transactionId }),
    );
  } catch (err) {
    await rollback(transactionId);
    throw err;
  }

  return result;
}

async function rollback(transactionId: string): Promise<void> {
  // Best-effort: if commit already failed, Postgres has typically already
  // aborted the transaction server-side and this may itself error — that's
  // fine, the original failure is what the caller needs to see.
  await client
    .send(new RollbackTransactionCommand({ resourceArn: RESOURCE_ARN, secretArn: SECRET_ARN, transactionId }))
    .catch(() => {});
}
