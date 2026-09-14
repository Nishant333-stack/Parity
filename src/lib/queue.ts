import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});

const QUEUE_URL = process.env.EVENT_QUEUE_URL!;

export interface EnqueueParams {
  readonly eventId: string;
  readonly groupId: string;
  readonly body: string;
}

/**
 * Hands a verified event to the ordered queue.
 *
 * MessageGroupId  — per-object ordering (see grouping.ts)
 * MessageDeduplicationId — the Stripe event id, which gives a second,
 *   independent dedupe layer inside SQS's 5-minute window. Belt and braces
 *   with the DynamoDB claim: SQS absorbs the concurrent replay storm, the
 *   table absorbs the replay that arrives a week later.
 */
export async function enqueueEvent(params: EnqueueParams): Promise<string> {
  const result = await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: params.body,
      MessageGroupId: params.groupId,
      MessageDeduplicationId: params.eventId,
    }),
  );

  if (!result.MessageId) {
    throw new Error('SQS accepted the message but returned no MessageId');
  }

  return result.MessageId;
}
