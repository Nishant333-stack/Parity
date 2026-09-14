import type Stripe from 'stripe';

/**
 * Chooses the FIFO MessageGroupId for an event.
 *
 * Ordering only has to hold for events about the *same money*. Grouping by
 * the Stripe object id gives exactly that, while letting unrelated payments
 * process in parallel — a single global group would serialise all throughput
 * for a guarantee nobody needs.
 *
 * The subtlety: a charge, its refunds and its disputes are all about one
 * payment intent. If each grouped by its own id they could interleave, and
 * `charge.refunded` could be projected before the charge that it refunds.
 * So anything carrying a payment_intent groups by the payment intent.
 */
export function resolveGroupId(event: Stripe.Event): string {
  // Stripe's Event.data.object is a discriminated union of ~70 resource
  // types. We only want two optional string fields that most of them happen
  // to share, so widen through `unknown` rather than switching on every type.
  const object = event.data.object as unknown as Record<string, unknown>;

  // Refunds, charges, disputes, application fees: all hang off a payment intent.
  const paymentIntent = object.payment_intent;
  if (typeof paymentIntent === 'string' && paymentIntent.length > 0) {
    return paymentIntent;
  }

  // Subscription-scoped objects (invoices, invoice items) order per subscription.
  const subscription = object.subscription;
  if (typeof subscription === 'string' && subscription.length > 0) {
    return subscription;
  }

  const id = object.id;
  if (typeof id === 'string' && id.length > 0) {
    return id;
  }

  // Degrade to per-event ordering rather than failing the request. An event
  // with no identifiable object cannot conflict with anything anyway.
  return event.id;
}
