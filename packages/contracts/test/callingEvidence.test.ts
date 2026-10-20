import { describe, expect, it } from 'vitest';
import { callingAdmissionCommandSchema, callingAssessmentCommandSchema } from '../src/index.ts';

const id = '00000000-0000-4000-8000-000000000001';
const envelope = { commandId: id, clientVersion: '1.0.56' };
const admission = { ...envelope, candidateId: id, expectedRevision: 1, qualificationRunId: id, phone: '+12125550123' };
const assessment = { ...envelope, firmId: id, officeAssessmentId: id };

describe('explicit calling-only commands', () => {
  it('accepts the exact owner-reviewed input envelopes', () => {
    expect(callingAdmissionCommandSchema.safeParse(admission).success).toBe(true);
    expect(callingAssessmentCommandSchema.safeParse(assessment).success).toBe(true);
  });
  it('does not accept caller-supplied policy, audit or automatic authority', () => {
    for (const extra of [{ mode: 'automatic' }, { policyVersion: 'trusted' }, { audit: [] }, { ownerUserId: id }]) {
      expect(callingAdmissionCommandSchema.safeParse({ ...admission, ...extra }).success).toBe(false);
      expect(callingAssessmentCommandSchema.safeParse({ ...assessment, ...extra }).success).toBe(false);
    }
  });
  it('requires exact revision, identifiers and normalized phone', () => {
    expect(callingAdmissionCommandSchema.safeParse({ ...admission, expectedRevision: 0 }).success).toBe(false);
    expect(callingAdmissionCommandSchema.safeParse({ ...admission, phone: '212-555-0123' }).success).toBe(false);
    expect(callingAdmissionCommandSchema.safeParse({ ...admission, qualificationRunId: 'unknown' }).success).toBe(false);
    expect(callingAssessmentCommandSchema.safeParse({ ...assessment, officeAssessmentId: null }).success).toBe(false);
  });
  it('requires the normal command and client envelope', () => {
    expect(callingAdmissionCommandSchema.safeParse({ ...admission, commandId: undefined }).success).toBe(false);
    expect(callingAssessmentCommandSchema.safeParse({ ...assessment, clientVersion: undefined }).success).toBe(false);
  });
});
