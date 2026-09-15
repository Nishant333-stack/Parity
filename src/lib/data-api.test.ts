import { describe, expect, it } from 'vitest';
import { numeric } from './data-api';

describe('numeric', () => {
  it('reads longValue — the common case for a plain bigint column', () => {
    expect(numeric({ longValue: 42 })).toBe(42);
  });

  it('reads doubleValue', () => {
    expect(numeric({ doubleValue: 42.5 })).toBe(42.5);
  });

  it('parses stringValue — this is the case that actually matters', () => {
    // SUM(bigint) in Postgres returns `numeric`, which the Data API
    // serializes as a stringValue, never a longValue. Treating longValue
    // as the only case silently produced $0.00 for every balance in this
    // project until this path was added — see CLAUDE.md's known-noise notes.
    expect(numeric({ stringValue: '123456' })).toBe(123456);
  });

  it('parses a negative stringValue — a ledger balance is a signed sum', () => {
    expect(numeric({ stringValue: '-4000' })).toBe(-4000);
  });

  it('returns 0 for an undefined field — SUM() over zero rows', () => {
    expect(numeric(undefined)).toBe(0);
  });

  it('returns 0 for an isNull field', () => {
    expect(numeric({ isNull: true })).toBe(0);
  });
});
