import { z } from 'zod';
import { uuid, sha256Hex, instant } from './foundationRows.ts';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';

export const crmCaptureReadRecoveryStateSchema = z.enum(['queued', 'probing', 'verified', 'refused', 'uncertain', 'stale']);
export const crmCaptureReadRecoveryReasonSchema = z.enum([
  'capture_authority_unavailable', 'mailbox_binding_changed', 'incident_not_eligible', 'additional_incident',
  'attempt_already_used', 'probe_in_progress', 'provider_refused', 'provider_uncertain',
  'profile_identity_mismatch', 'recovery_binding_changed', 'capture_read_verified', 'capture_consumer_unavailable',
]);
export const crmCaptureReadRecoveryReadSchema = z.strictObject({ mailboxId: uuid });
export const crmCaptureReadRecoveryPayloadSchema = z.strictObject({
  mailboxId: uuid, expectedGeneration: z.number().int().positive(), incidentId: uuid, expectedRecoveryBinding: sha256Hex,
});
export const crmCaptureReadRecoveryRequestSchema = crmCaptureReadRecoveryPayloadSchema.extend({
  commandId: commandIdSchema, clientVersion: semanticVersionSchema,
});
export const crmCaptureReadRecoveryAttemptSchema = z.strictObject({
  attemptId: uuid, state: crmCaptureReadRecoveryStateSchema, reason: crmCaptureReadRecoveryReasonSchema.nullable(),
  requestedAt: instant, probeStartedAt: instant.nullable(), completedAt: instant.nullable(),
});
export const crmCaptureReadRecoveryStatusSchema = z.strictObject({
  mailboxId: uuid, generation: z.number().int().positive().nullable(), eligible: z.boolean(),
  incidentId: uuid.nullable(), recoveryBinding: sha256Hex.nullable(), reason: crmCaptureReadRecoveryReasonSchema.nullable(),
  attempt: crmCaptureReadRecoveryAttemptSchema.nullable(),
  sendingUnchanged: z.literal(true), holdsUnchanged: z.literal(true), providerCoverage: z.literal('unproven'),
});
export const crmCaptureReadRecoveryAcknowledgmentSchema = z.strictObject({
  attemptId: uuid, state: crmCaptureReadRecoveryStateSchema, sendingUnchanged: z.literal(true), holdsUnchanged: z.literal(true),
});
export type CrmCaptureReadRecoveryPayload = z.infer<typeof crmCaptureReadRecoveryPayloadSchema>;
export type CrmCaptureReadRecoveryStatus = z.infer<typeof crmCaptureReadRecoveryStatusSchema>;
export type CrmCaptureReadRecoveryAttempt = z.infer<typeof crmCaptureReadRecoveryAttemptSchema>;
