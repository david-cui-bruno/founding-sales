import { describe, expect, it } from 'vitest';
import { crmCaptureReadRecoveryRequestSchema, crmCaptureReadRecoveryStatusSchema,
  crmCaptureReadRecoveryAcknowledgmentSchema } from '../src/crmCaptureReadRecovery.ts';

const id = '243703e0-726f-453e-a5a8-eae645b43b2d';
const request = { mailboxId: id, incidentId: id, expectedGeneration: 2, expectedRecoveryBinding: 'a'.repeat(64),
  commandId: id, clientVersion: '1.0.56' };
const status = { mailboxId: id, generation: 2, eligible: true, incidentId: id, recoveryBinding: 'a'.repeat(64),
  reason: null, attempt: null, sendingUnchanged: true, holdsUnchanged: true, providerCoverage: 'unproven' };

describe('capture-only recovery boundary', () => {
  it('requires ordinary command identity and exact generation/incident binding', () => {
    expect(crmCaptureReadRecoveryRequestSchema.parse(request)).toEqual(request);
    for (const key of ['mailboxId', 'incidentId', 'expectedGeneration', 'expectedRecoveryBinding', 'commandId', 'clientVersion']) {
      const value: Record<string, unknown> = { ...request };
      delete value[key];
      expect(crmCaptureReadRecoveryRequestSchema.safeParse(value).success).toBe(false);
    }
  });
  it.each([0, -1, 1.5, NaN, Infinity])('refuses invalid generation %s', expectedGeneration => {
    expect(crmCaptureReadRecoveryRequestSchema.safeParse({ ...request, expectedGeneration }).success).toBe(false);
  });
  it.each(['enableSending', 'clearIncident', 'retryAt', 'cutoff', 'ownerUserId', 'accessToken'])('refuses caller-supplied authority %s', key => {
    expect(crmCaptureReadRecoveryRequestSchema.safeParse({ ...request, [key]: true }).success).toBe(false);
  });
  it('does not report coverage or release any sending hold', () => {
    expect(crmCaptureReadRecoveryStatusSchema.parse(status)).toEqual(status);
    for (const patch of [{ sendingUnchanged: false }, { holdsUnchanged: false }, { providerCoverage: 'complete' }]) {
      expect(crmCaptureReadRecoveryStatusSchema.safeParse({ ...status, ...patch }).success).toBe(false);
    }
  });
  it('returns one stable coded attempt, not credentials or raw provider results', () => {
    const value = { attemptId: id, state: 'queued', sendingUnchanged: true, holdsUnchanged: true };
    expect(crmCaptureReadRecoveryAcknowledgmentSchema.parse(value)).toEqual(value);
    expect(crmCaptureReadRecoveryAcknowledgmentSchema.safeParse({ ...value, accessToken: 'not-a-token' }).success).toBe(false);
    expect(crmCaptureReadRecoveryAcknowledgmentSchema.safeParse({ ...value, state: 'incident_resolved' }).success).toBe(false);
  });
});
