import { expect, it } from 'vitest';
import { formatVisibleCount, type VisibleCount } from './visibleCount';

it.each([
  [{ kind: 'known', value: 0 }, '0'],
  [{ kind: 'known', value: 7 }, '7'],
  [{ kind: 'unavailable' }, 'Unavailable'],
  [{ kind: 'partial', value: 0 }, '0+ · partial'],
  [{ kind: 'partial', value: 4 }, '4+ · partial'],
  [{ kind: 'last_known', value: 0 }, '0 · last known'],
  [{ kind: 'checking', value: null }, 'Checking'],
  [{ kind: 'checking', value: 0 }, '0 · checking'],
] as Array<[VisibleCount, string]>)('formats %j as %s', (count, expected) => {
  expect(formatVisibleCount(count)).toBe(expected);
});
