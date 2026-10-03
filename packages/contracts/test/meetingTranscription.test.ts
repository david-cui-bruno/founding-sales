import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DEFAULT_STORED_SETTING_VALUES, STORED_SETTING_VALUE_SCHEMAS } from '../src/settings.ts';
describe('meeting transcription configuration', () => {
    const schema = () => (STORED_SETTING_VALUE_SCHEMAS as Readonly<Record<string, z.ZodType>>)['meeting_transcription'];
    it('starts disabled without a spending allowance or invented credit coverage', () => {
        expect((DEFAULT_STORED_SETTING_VALUES as Readonly<Record<string, unknown>>)['meeting_transcription'])
            .toEqual({ enabled: false, dailyCeilingCents: 0, creditCoverage: null });
    });
    it('refuses an excessive budget and invalid credit evidence dates', () => {
        expect(schema()).toBeDefined();
        expect(schema()?.safeParse({ enabled: true, dailyCeilingCents: 501, creditCoverage: null }).success).toBe(false);
        const creditCoverage = { accountId: '123456789012', service: 'transcribe', evidenceRef: 'credit-terms-checked',
            verifiedAt: '2026-10-03T12:00:00Z', validUntil: '2026-10-01T12:00:00Z', status: 'verified' };
        expect(schema()?.safeParse({ enabled: true, dailyCeilingCents: 50, creditCoverage }).success).toBe(false);
        expect(schema()?.safeParse({ enabled: true, dailyCeilingCents: 50,
            creditCoverage: { ...creditCoverage, validUntil: '2026-11-01T12:00:00Z' } }).success).toBe(true);
    });
});
