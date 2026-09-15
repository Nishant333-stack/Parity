import Stripe from 'stripe';
import { getSecret } from './secrets';

const SECRET_KEY_PARAM = process.env.STRIPE_SECRET_KEY_PARAM!;

let client: Stripe | undefined;

/** Cached for the life of the execution environment, same pattern as getSecret(). */
export async function getStripeClient(): Promise<Stripe> {
  if (!client) client = new Stripe(await getSecret(SECRET_KEY_PARAM));
  return client;
}
