import { describe, expect, it } from 'vitest';

import { formatRelativeTime } from './relativeTime';

const NOW = new Date('2026-09-01T12:00:00.000Z');

describe('formatRelativeTime', () => {
  it('renders sub-minute moments as now', () => {
    expect(formatRelativeTime('2026-09-01T11:59:30.000Z', NOW)).toBe('now');
  });

  it('renders minutes, hours, and days compactly', () => {
    expect(formatRelativeTime('2026-09-01T11:45:00.000Z', NOW)).toBe('15m ago');
    expect(formatRelativeTime('2026-09-01T08:00:00.000Z', NOW)).toBe('4h ago');
    expect(formatRelativeTime('2026-08-30T12:00:00.000Z', NOW)).toBe('2d ago');
  });

  it('falls back to a short date after a week', () => {
    expect(formatRelativeTime('2026-08-10T12:00:00.000Z', NOW)).toMatch(/Aug/);
  });

  it('includes the year across year boundaries', () => {
    expect(formatRelativeTime('2025-12-20T12:00:00.000Z', NOW)).toMatch(/2025/);
  });

  it('passes through unparseable input', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('not-a-date');
  });
});
