import { z } from 'zod';
import { instant, uuid } from './foundationRows.ts';

/** A separate explicit research purpose, never contact permission or dial clearance. */
export const researchPurposeSchema = z.enum(['brief', 'office_evidence']);
export type ResearchPurpose = z.infer<typeof researchPurposeSchema>;

export const firmOfficeAssessmentSchema = z.object({
  status: z.enum(['not_evaluated', 'pending', 'supported', 'unclear', 'stale']),
  reason: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u).nullable(),
  assessmentId: uuid.nullable(),
  researchRunId: uuid.nullable(),
  routeId: uuid.nullable(),
  routeVersion: z.number().int().min(1).nullable(),
  assessedAt: instant.nullable(),
  expiresAt: instant.nullable(),
  sourceCount: z.number().int().min(0).max(8),
  policyVersion: z.string().min(1).max(80).nullable(),
});
export type FirmOfficeAssessmentView = z.infer<typeof firmOfficeAssessmentSchema>;

/** Old servers have never evaluated this purpose. Absence is not positive evidence. */
export const unevaluatedFirmOfficeAssessment = (): FirmOfficeAssessmentView => ({
  status: 'not_evaluated',
  reason: null,
  assessmentId: null,
  researchRunId: null,
  routeId: null,
  routeVersion: null,
  assessedAt: null,
  expiresAt: null,
  sourceCount: 0,
  policyVersion: null,
});
