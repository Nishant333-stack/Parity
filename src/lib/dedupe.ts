import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE = process.env.DEDUPE_TABLE!;

/** Rows outlive Stripe's 30-day retry window so month-old replays still dedupe. */
const TTL_SECONDS = 35 * 24 * 60 * 60;

export type ClaimResult = 'claimed' | 'duplicate';

function key(eventId: string): string {
  return `evt#${eventId}`;
}

/**
 * Attempts to take ownership of an event id.
 *
 * A conditional put is the whole mechanism: DynamoDB decides the winner, so
 * fifty concurrent deliveries of one event produce exactly one 'claimed' and
 * forty-nine 'duplicate'. No locks, no read-then-write race.
 */
export async function claimEvent(params: {
  eventId: string;
  eventType: string;
  groupId: string;
}): Promise<ClaimResult> {
  try {
    await client.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          pk: key(params.eventId),
          status: 'CLAIMED',
          eventType: params.eventType,
          groupId: params.groupId,
          claimedAt: new Date().toISOString(),
          expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return 'claimed';
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return 'duplicate';
    throw err;
  }
}

/** Marks a claim as safely handed to the queue. */
export async function markEnqueued(eventId: string, messageId: string): Promise<void> {
  await client.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { pk: key(eventId) },
      UpdateExpression:
        'SET #s = :enqueued, enqueuedAt = :now, sqsMessageId = :mid',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':enqueued': 'ENQUEUED',
        ':now': new Date().toISOString(),
        ':mid': messageId,
      },
    }),
  );
}

/**
 * Releases a claim when the enqueue that followed it failed.
 *
 * Without this, a transient SQS error would leave the event permanently
 * marked as seen and silently dropped — the worst failure mode this system
 * has, because nothing would ever notice.
 */
export async function releaseClaim(eventId: string): Promise<void> {
  await client.send(
    new DeleteCommand({ TableName: TABLE, Key: { pk: key(eventId) } }),
  );
}
