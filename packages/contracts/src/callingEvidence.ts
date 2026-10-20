import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { e164, uuid } from './foundationRows.ts';

// Explicit owner-reviewed calling evidence operations. These do not authorize a
// call or change qualification admission, email eligibility or SMS eligibility.
export const callingAdmissionInputSchema = z.strictObject({
  candidateId: uuid,
  expectedRevision: z.number().int().positive(),
  qualificationRunId: uuid,
  phone: e164,
});
export type CallingAdmissionInput = z.infer<typeof callingAdmissionInputSchema>;

export const callingAssessmentInputSchema = z.strictObject({
  firmId: uuid,
  officeAssessmentId: uuid,
});
export type CallingAssessmentInput = z.infer<typeof callingAssessmentInputSchema>;

const envelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
export const callingAdmissionCommandSchema = callingAdmissionInputSchema.extend(envelope);
export const callingAssessmentCommandSchema = callingAssessmentInputSchema.extend(envelope);
