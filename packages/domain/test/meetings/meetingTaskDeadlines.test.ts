import { describe, expect, it } from 'vitest';
describe('meeting promise dates', () => {
  it('keeps date precision through midnight and DST, and never guesses a missing zone', async () => {
    const { resolveMeetingDeadline, meetingDeadlineDueAt } = await import('../../meetings/taskDeadlines.ts');
    const input = { text: 'tomorrow', anchorAt: '2026-11-01T03:30:00Z', zone: 'America/New_York', sourceKind: 'transcript' as const };
    const result = resolveMeetingDeadline(input);
    expect(result).toEqual({ ok: true, value: { precision: 'date', localDate: '2026-11-01', zone: 'America/New_York' } });
    if (!result.ok) throw new Error(result.reason);
    expect(meetingDeadlineDueAt(result.value)).toBe('2026-11-02T05:00:00.000Z');
    expect(resolveMeetingDeadline({ ...input, zone: null })).toMatchObject({ ok: false });
    for (const text of ['next week', 'Friday or Monday', 'soon', '2026-02-30', 'tomorrow at 2', '2026-03-08 at 2:30 am']) {
      expect(resolveMeetingDeadline({ ...input, text }), text).toMatchObject({ ok: false });
    }
  });
  it('resolves only an explicit date/time in its stated zone', async () => {
    const { resolveMeetingDeadline } = await import('../../meetings/taskDeadlines.ts');
    expect(resolveMeetingDeadline({ text: '2026-10-08 at 2:30 pm', anchorAt: '2026-10-03T12:00:00Z', zone: 'America/Chicago', sourceKind: 'debrief' })).toEqual({ ok: true, value: { precision: 'instant', at: '2026-10-08T19:30:00.000Z', zone: 'America/Chicago' } });
    expect(resolveMeetingDeadline({ text: 'on October 8, 2026', anchorAt: '2026-10-03T12:00:00Z', zone: 'America/Chicago', sourceKind: 'debrief' })).toEqual({ ok: true, value: { precision: 'date', localDate: '2026-10-08', zone: 'America/Chicago' } });
  });
});
