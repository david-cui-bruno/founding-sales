import { z } from 'zod';

/** Scope negotiation on existing owner routes, never activation by itself. */
export const CRM_OWNER_SCOPE_VERSION = 'gmail-forward-only-v1' as const;
export const crmOwnerScopeVersionSchema = z.literal(CRM_OWNER_SCOPE_VERSION);
export const crmForwardCaptureScopeSchema = z.strictObject({
  mode: z.literal('forward_only'),
  // Conservative DB-derived millisecond cutoff, not a sender Date header.
  enabledAt: z.iso.datetime({ precision: 3 }),
});
export type CrmForwardCaptureScope = z.infer<typeof crmForwardCaptureScopeSchema>;

export const crmExtractionSourceKindsSchema = z.union([
  z.tuple([]),
  z.tuple([z.literal('mail')]),
]);
export const crmExtractionSourceScopeSchema = z.union([
  z.strictObject({ allowedSourceKinds: z.tuple([]), mailCaptureOwnerApprovalId: z.null() }),
  z.strictObject({ allowedSourceKinds: z.tuple([z.literal('mail')]), mailCaptureOwnerApprovalId: z.uuid() }),
]);
export type CrmExtractionSourceScope = z.infer<typeof crmExtractionSourceScopeSchema>;

/** Missing fields are historical parse compatibility, not current authority. */
export function hasConsistentCrmExtractionSourceScope(input: {
  allowedSourceKinds?: unknown;
  mailCaptureOwnerApprovalId?: unknown;
}): boolean {
  if (input.allowedSourceKinds === undefined && input.mailCaptureOwnerApprovalId === undefined) return true;
  return crmExtractionSourceScopeSchema.safeParse({
    allowedSourceKinds: input.allowedSourceKinds,
    mailCaptureOwnerApprovalId: input.mailCaptureOwnerApprovalId,
  }).success;
}
