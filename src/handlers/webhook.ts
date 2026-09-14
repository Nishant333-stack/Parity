import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { claimEvent, markEnqueued, releaseClaim } from '../lib/dedupe';
import { resolveGroupId } from '../lib/grouping';
import { enqueueEvent } from '../lib/queue';
import { getSecret } from '../lib/secrets';

const SECRET_KEY_PARAM = process.env.STRIPE_SECRET_KEY_PARAM!;
const WEBHOOK_SECRET_PARAM = process.env.STRIPE_WEBHOOK_SECRET_PARAM!;
const ALLOW_LIVEMODE = process.env.ALLOW_LIVEMODE === 'true';

let stripe: Stripe | undefined;
let webhookSecret: string | undefined;

async function init(): Promise<{ stripe: Stripe; webhookSecret: string }> {
  if (!stripe) stripe = new Stripe(await getSecret(SECRET_KEY_PARAM));
  if (!webhookSecret) webhookSecret = await getSecret(WEBHOOK_SECRET_PARAM);
  return { stripe, webhookSecret };
}

function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify(fields));
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  // Stripe signs the EXACT bytes it sent. API Gateway may hand them over
  // base64-encoded, and any re-serialisation (JSON.parse then stringify)
  // silently breaks verification. This is the single most common way a
  // Stripe integration fails for reasons that look like a key problem.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64')
    : Buffer.from(event.body ?? '', 'utf8');

  // HTTP API lower-cases header names.
  const signature = event.headers['stripe-signature'];
  if (!signature) {
    log({ msg: 'rejected', reason: 'missing_signature' });
    return json(400, { error: 'missing stripe-signature header' });
  }

  let client: Stripe;
  let secret: string;
  try {
    ({ stripe: client, webhookSecret: secret } = await init());
  } catch (err) {
    // A config failure is ours, not Stripe's. Return 500 so Stripe retries
    // rather than treating the event as permanently rejected.
    log({ msg: 'init_failed', error: (err as Error).message });
    return json(500, { error: 'configuration error' });
  }

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = client.webhooks.constructEvent(rawBody, signature, secret);
  } catch (err) {
    // Forged or stale signature. Rejected here, before any work, and never
    // claimed or enqueued. Week 7's forged-signature injector asserts this.
    log({ msg: 'rejected', reason: 'invalid_signature', error: (err as Error).message });
    return json(400, { error: 'invalid signature' });
  }

  if (stripeEvent.livemode && !ALLOW_LIVEMODE) {
    log({ msg: 'rejected', reason: 'livemode_refused', id: stripeEvent.id });
    return json(400, { error: 'livemode events are not accepted' });
  }

  const groupId = resolveGroupId(stripeEvent);

  // Claim before enqueue. DynamoDB's conditional write picks exactly one
  // winner among concurrent duplicates, so the replay storm costs one
  // enqueue and forty-nine cheap rejections.
  let claim: Awaited<ReturnType<typeof claimEvent>>;
  try {
    claim = await claimEvent({
      eventId: stripeEvent.id,
      eventType: stripeEvent.type,
      groupId,
    });
  } catch (err) {
    log({ msg: 'claim_failed', id: stripeEvent.id, error: (err as Error).message });
    return json(500, { error: 'dedupe unavailable' });
  }

  if (claim === 'duplicate') {
    log({ msg: 'duplicate_ignored', id: stripeEvent.id, type: stripeEvent.type });
    // 200, not an error: Stripe did nothing wrong, and we want it to stop
    // retrying an event we already hold.
    return json(200, { received: true, id: stripeEvent.id, duplicate: true });
  }

  let messageId: string;
  try {
    messageId = await enqueueEvent({
      eventId: stripeEvent.id,
      groupId,
      body: rawBody.toString('utf8'),
    });
  } catch (err) {
    // The claim is now a lie — we own an event that never reached the queue.
    // Release it so Stripe's retry can succeed, and fail loudly. Leaving the
    // claim in place would drop the event permanently and silently, which is
    // the worst outcome this system can produce.
    log({ msg: 'enqueue_failed', id: stripeEvent.id, error: (err as Error).message });
    try {
      await releaseClaim(stripeEvent.id);
    } catch (releaseErr) {
      // Now it IS stuck as CLAIMED. The Week 5 reconciler is the backstop:
      // a claim with no matching ledger entry surfaces as drift and is
      // backfilled from /v2/core/events.
      log({
        msg: 'release_failed',
        id: stripeEvent.id,
        error: (releaseErr as Error).message,
        note: 'stranded CLAIMED row — reconciler must backfill',
      });
    }
    return json(500, { error: 'could not enqueue' });
  }

  // Best-effort bookkeeping. A failure here leaves the row CLAIMED rather
  // than ENQUEUED, which the reconciler treats as suspicious but which does
  // not lose the event: it is already safely on the queue.
  try {
    await markEnqueued(stripeEvent.id, messageId);
  } catch (err) {
    log({ msg: 'mark_enqueued_failed', id: stripeEvent.id, error: (err as Error).message });
  }

  log({
    msg: 'event_received',
    id: stripeEvent.id,
    type: stripeEvent.type,
    groupId,
    messageId,
    apiVersion: stripeEvent.api_version,
    created: stripeEvent.created,
    livemode: stripeEvent.livemode,
  });

  return json(200, { received: true, id: stripeEvent.id });
};
