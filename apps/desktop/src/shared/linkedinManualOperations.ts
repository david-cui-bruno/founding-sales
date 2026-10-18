import { z } from 'zod';
import { commandIdSchema, linkedinManualBindSchema, linkedinManualRecordSchema, linkedinManualReadSchema, linkedinManualViewSchema } from '@fss/contracts';

export const linkedinManualOperationResult = z.strictObject({ view: linkedinManualViewSchema.nullable(), reason: z.string().nullable() });
export const linkedinManualMutationResult = linkedinManualOperationResult.extend({ accepted: z.boolean() });
export const LINKEDIN_MANUAL_OPERATIONS = {
  'linkedinManual.read': {
    kind: 'read', calls: [{ method: 'POST', path: '/crm/linkedin/manual/read' }],
    input: linkedinManualReadSchema, output: linkedinManualOperationResult,
    transform: 'Current owner assertions only, no inbox coverage or native observations',
  },
  'linkedinManual.bind': {
    kind: 'command', calls: [{ method: 'POST', path: '/crm/linkedin/manual/bind' }, { method: 'POST', path: '/crm/linkedin/manual/read' }],
    input: linkedinManualBindSchema.extend({ commandId: commandIdSchema }), output: linkedinManualMutationResult,
    transform: 'Account-bound existing Person/Firm/profile identity, never outreach authority',
  },
  'linkedinManual.record': {
    kind: 'command', calls: [{ method: 'POST', path: '/crm/linkedin/manual/record' }, { method: 'POST', path: '/crm/linkedin/manual/read' }],
    input: linkedinManualRecordSchema.safeExtend({ commandId: commandIdSchema }), output: linkedinManualMutationResult,
    transform: 'Append-only dated owner assertions/corrections, replies/refusals stop follow-up',
  },
} as const;
