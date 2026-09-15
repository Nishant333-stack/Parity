import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { resolveGroupId } from './grouping';

function eventOf(object: Record<string, unknown>): Stripe.Event {
  return { id: 'evt_fallback', data: { object } } as unknown as Stripe.Event;
}

describe('resolveGroupId', () => {
  it('groups by payment_intent when present — the whole reason this function exists', () => {
    expect(resolveGroupId(eventOf({ id: 'ch_1', payment_intent: 'pi_1' }))).toBe('pi_1');
  });

  it('groups a refund by its payment_intent, not its own object id', () => {
    // The case ADR 0001 is actually about: a charge and its refund must land
    // in the same FIFO group, or the refund can be projected first.
    const charge = resolveGroupId(eventOf({ id: 'ch_1', payment_intent: 'pi_1' }));
    const refund = resolveGroupId(eventOf({ id: 're_1', payment_intent: 'pi_1' }));
    expect(refund).toBe(charge);
  });

  it('falls back to subscription when there is no payment_intent', () => {
    expect(resolveGroupId(eventOf({ id: 'in_1', subscription: 'sub_1' }))).toBe('sub_1');
  });

  it('falls back to the object id when there is neither', () => {
    expect(resolveGroupId(eventOf({ id: 'cus_1' }))).toBe('cus_1');
  });

  it('falls back to the event id when the object has no usable id at all', () => {
    expect(resolveGroupId(eventOf({}))).toBe('evt_fallback');
  });

  it('ignores a non-string or empty payment_intent rather than grouping by "[object Object]"', () => {
    expect(resolveGroupId(eventOf({ id: 'ch_1', payment_intent: '' }))).toBe('ch_1');
    expect(resolveGroupId(eventOf({ id: 'ch_1', payment_intent: { id: 'pi_1' } }))).toBe('ch_1');
  });
});
