import { describe, expect, it } from 'vitest';
import type Stripe from 'stripe';
import { project } from './projection';

function eventOf(type: string, object: Record<string, unknown>): Stripe.Event {
  return { type, data: { object } } as unknown as Stripe.Event;
}

describe('project', () => {
  it('books a charge.succeeded as cash in, payable to the merchant', () => {
    const entries = project(eventOf('charge.succeeded', { amount: 5_000 }));

    expect(entries).toEqual([
      { account: 'stripe:cash', amountCents: 5_000n },
      { account: 'merchants:payable', amountCents: -5_000n },
    ]);
  });

  it('books a charge.refunded as the exact reverse, using amount_refunded', () => {
    const entries = project(eventOf('charge.refunded', { amount: 5_000, amount_refunded: 2_000 }));

    expect(entries).toEqual([
      { account: 'merchants:payable', amountCents: 2_000n },
      { account: 'stripe:cash', amountCents: -2_000n },
    ]);
  });

  it('books nothing for charge.dispute.created — creation alone does not mean funds moved', () => {
    // Verified against this account: `stripe trigger charge.dispute.created`
    // produced a dispute with status "warning_needs_response" and
    // balance_transaction: null — an inquiry-type dispute Stripe never
    // actually debited. See the comment on project() and ADR 0005's amendment.
    expect(project(eventOf('charge.dispute.created', { amount: 1_500 }))).toEqual([]);
  });

  it('books a charge.dispute.funds_withdrawn as held funds, out of cash', () => {
    const entries = project(eventOf('charge.dispute.funds_withdrawn', { amount: 1_500 }));

    expect(entries).toEqual([
      { account: 'disputes:held', amountCents: 1_500n },
      { account: 'stripe:cash', amountCents: -1_500n },
    ]);
  });

  it('books a charge.dispute.funds_reinstated as the exact reverse', () => {
    const entries = project(eventOf('charge.dispute.funds_reinstated', { amount: 1_500 }));

    expect(entries).toEqual([
      { account: 'stripe:cash', amountCents: 1_500n },
      { account: 'disputes:held', amountCents: -1_500n },
    ]);
  });

  it('books a payout.paid as cash leaving Stripe for the external bank account', () => {
    const entries = project(eventOf('payout.paid', { amount: 9_539 }));

    expect(entries).toEqual([
      { account: 'bank:external', amountCents: 9_539n },
      { account: 'stripe:cash', amountCents: -9_539n },
    ]);
  });

  it('books nothing for payout.failed — no cash left the platform to reverse', () => {
    expect(project(eventOf('payout.failed', { amount: 9_539 }))).toEqual([]);
  });

  it('books nothing for payment_intent.* — it would double-count the charge', () => {
    expect(project(eventOf('payment_intent.succeeded', { amount: 5_000 }))).toEqual([]);
  });

  it('books nothing for an event type it does not recognize', () => {
    expect(project(eventOf('customer.created', {}))).toEqual([]);
  });

  it('every pair sums to zero, for every booked event type', () => {
    const cases = [
      eventOf('charge.succeeded', { amount: 999 }),
      eventOf('charge.refunded', { amount_refunded: 999 }),
      eventOf('charge.dispute.funds_withdrawn', { amount: 999 }),
      eventOf('charge.dispute.funds_reinstated', { amount: 999 }),
      eventOf('payout.paid', { amount: 999 }),
    ];

    for (const event of cases) {
      const sum = project(event).reduce((total, e) => total + e.amountCents, 0n);
      expect(sum).toBe(0n);
    }
  });

  it('books nothing for a zero-amount event, rather than two zero-magnitude entries', () => {
    // entries.amount_cents has a CHECK (amount_cents <> 0) — a zero-amount
    // pair would violate it, so this function must never produce one.
    expect(project(eventOf('charge.succeeded', { amount: 0 }))).toEqual([]);
  });

  it('rejects a non-integer amount rather than silently truncating money', () => {
    expect(() => project(eventOf('charge.succeeded', { amount: 50.5 }))).toThrow(
      /expected an integer cents amount/,
    );
  });

  it('rejects a missing amount rather than booking undefined as zero', () => {
    expect(() => project(eventOf('charge.succeeded', {}))).toThrow(/expected an integer cents amount/);
  });
});
