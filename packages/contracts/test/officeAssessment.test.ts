import { describe, expect, it } from 'vitest';
import { researchRunCommandSchema, researchRunResultSchema } from '../src/research.ts';
import { firmOfficeAssessmentSchema, unevaluatedFirmOfficeAssessment } from '../src/officeAssessment.ts';

const request = { commandId: 'research:office:1', clientVersion: '1.0.55', firmId: '11111111-1111-4111-8111-111111111111' };

describe('explicit office evidence research contract', () => {
  it('preserves omitted-purpose receipt input exactly', () => {
    expect(researchRunCommandSchema.parse(request)).toEqual(request);
    expect(Object.hasOwn(researchRunCommandSchema.parse(request), 'purpose')).toBe(false);
  });
  it('accepts only the two known purposes without inferred requester authority', () => {
    for (const purpose of ['brief', 'office_evidence']) {
      expect(researchRunCommandSchema.parse({ ...request, purpose })).toEqual({ ...request, purpose });
    }
    for (const patch of [{ purpose: 'qualification' }, { requestedByUserId: request.firmId }, { routeId: request.firmId }]) {
      expect(researchRunCommandSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
  });
  it('defaults old command receipts to brief and preserves explicit office results', () => {
    expect(researchRunResultSchema.parse({ revision: 1, queued: true })).toEqual({ revision: 1, queued: true, purpose: 'brief' });
    expect(researchRunResultSchema.parse({ revision: 2, queued: false, purpose: 'office_evidence' }).purpose).toBe('office_evidence');
  });
  it('represents old-server absence as unevaluated with no route or permission', () => {
    const empty = unevaluatedFirmOfficeAssessment();
    expect(firmOfficeAssessmentSchema.parse(empty)).toEqual(empty);
    expect(empty.status).toBe('not_evaluated');
    expect(empty.routeId).toBeNull();
    expect(Object.keys(empty)).not.toContain('callable');
    expect(Object.keys(empty)).not.toContain('telUri');
    expect(firmOfficeAssessmentSchema.safeParse({ ...empty, sourceCount: 9 }).success).toBe(false);
    expect(firmOfficeAssessmentSchema.safeParse({ ...empty, reason: 'raw private text' }).success).toBe(false);
  });
});
