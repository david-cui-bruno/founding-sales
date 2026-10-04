import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.ts';
const id = '11111111-1111-4111-8111-111111111111';
describe('meeting notes contracts', () => {
  it('bounds debrief bytes and refuses impossible dates or missing zones', () => {
    expect(contracts).toHaveProperty('saveMeetingNotesSchema');
    const input = { meetingId: id, expectedRevision: 0, debrief: 'A short debrief', speakerMappings: [], itemOverrides: [], sufficient: false };
    expect(contracts.saveMeetingNotesSchema.safeParse(input).success).toBe(true);
    expect(contracts.saveMeetingNotesSchema.safeParse({ ...input, debrief: '😀'.repeat(8193) }).success).toBe(false);
    expect(contracts.meetingDeadlineSchema.safeParse({ precision: 'date', localDate: '2026-02-30', zone: 'America/New_York' }).success).toBe(false);
    expect(contracts.meetingDeadlineSchema.safeParse({ precision: 'date', localDate: '2026-11-01', zone: 'America/New_York' }).success).toBe(true);
    expect(contracts.meetingDeadlineSchema.safeParse({ precision: 'date', localDate: '2026-11-01', zone: 'Atlantis' }).success).toBe(false);
  });
  it('starts analysis independently disabled and refuses transcription coverage', () => {
    expect(contracts).toHaveProperty('DEFAULT_MEETING_ANALYSIS');
    expect(contracts.DEFAULT_MEETING_ANALYSIS).toEqual({ enabled: false, dailyCeilingCents: 0, creditCoverage: null });
    expect(contracts.meetingAnalysisSettingSchema.safeParse({ enabled: true, dailyCeilingCents: 501, creditCoverage: null }).success).toBe(false);
    expect(contracts.meetingAnalysisSettingSchema.safeParse({ enabled: true, dailyCeilingCents: 50, creditCoverage: {
      accountId: '123456789012', service: 'transcribe', evidenceRef: 'local-test', verifiedAt: '2026-10-01T00:00:00Z', validUntil: '2026-11-01T00:00:00Z', status: 'verified',
    } }).success).toBe(false);
  });
});
