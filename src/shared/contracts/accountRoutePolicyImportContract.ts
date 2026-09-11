import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { accountRoutePolicySchema } from './accountRoutePolicyContract';
import { contactComplianceEvidenceSchema } from '../../main/domain/compliance/contactComplianceTypes';

export const POLICY_IMPORT_MAX_BYTES = 1048576;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(1).max(2000);
const ids = z.array(id).min(1).max(100).refine(values => new Set(values).size === values.length);
const documentSchema = z.strictObject({ id, mediaType: z.literal('text/plain'), content: z.string().min(1).max(POLICY_IMPORT_MAX_BYTES), sha256: hash });
const citationSchema = z.strictObject({ documentId: id, field: z.enum(['contact.validationState', 'contact.evidence', 'jurisdiction', 'clearance']), excerpt: z.string().min(1).max(12000) });
const importPolicySchema = accountRoutePolicySchema.superRefine((policy, context) => {
  const result = contactComplianceEvidenceSchema.safeParse(policy.contact.evidence);
  if (!result.success) for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: ['contact', 'evidence', ...issue.path] });
  if (policy.contact.kind !== 'phone' || policy.contact.evidence.source !== 'manual_import') context.addIssue({ code: 'custom', message: 'This interchange accepts only explicitly manual-import phone evidence.' });
});
export const policyImportRowSchema = z.strictObject({ rowId: id, accountId: id, routeId: id,
  expectedRouteVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), expectedEvidenceFingerprint: hash,
  targetSourceIds: ids, documentIds: ids, citations: z.array(citationSchema).min(1).max(100),
  observedAt: instant, effectiveAt: instant, expiresAt: instant,
  operation: z.enum(['observe', 'authoritative_correction']), reason, policy: importPolicySchema,
});
export const accountRoutePolicyImportArtifactSchema = z.strictObject({ format: z.literal('fss-account-route-policy-review'), version: z.literal(1), workspaceId: z.uuid(),
  documents: z.array(documentSchema).min(1).max(100), rows: z.array(policyImportRowSchema).min(1).max(100),
}).superRefine((artifact, context) => {
  if (new Set(artifact.documents.map(doc => doc.id)).size !== artifact.documents.length || new Set(artifact.rows.map(row => row.rowId)).size !== artifact.rows.length) context.addIssue({ code: 'custom', message: 'Duplicate document or row identity.' });
  for (const row of artifact.rows) {
    if (row.documentIds.some(docId => !artifact.documents.some(doc => doc.id === docId)) || row.citations.some(citation => !row.documentIds.includes(citation.documentId) || !artifact.documents.find(doc => doc.id === citation.documentId)?.content.includes(citation.excerpt))) context.addIssue({ code: 'custom', message: 'Every citation must quote an exact included document.' });
  }
});
export const policyImportConfirmSchema = z.strictObject({ previewId: id, expectedArtifactHash: hash, reviewReason: reason });
export const policyImportResumeSchema = z.strictObject({ reviewId: z.uuid(), expectedArtifactHash: hash });
export const policyImportStatusSchema = z.strictObject({ reviewId: z.uuid() });
export const policyImportPreviewSchema = z.strictObject({ previewId: id, artifactHash: hash, reviewId: z.uuid(), artifact: accountRoutePolicyImportArtifactSchema,
  rows: z.array(z.strictObject({ rowId: id, receiptId: id.nullable(), policy: accountRoutePolicySchema.nullable(), heldReason: z.string().nullable() })).min(1).max(100),
  notice: z.literal('Owner-reviewed FSS evidence interchange. Not government or vendor verification, legal clearance, or permission to call.'),
});
export const policyImportReportSchema = z.strictObject({ reviewId: z.uuid(), artifactHash: hash, reviewedAt: instant,
  rows: z.array(z.strictObject({ rowId: id, receiptId: id.nullable(), status: z.enum(['admitted', 'held', 'pending']), reason: z.string().nullable(), receiptFingerprint: hash.nullable() })).min(1).max(100),
});
export type AccountRoutePolicyImportArtifact = z.infer<typeof accountRoutePolicyImportArtifactSchema>;
export type PolicyImportRow = z.infer<typeof policyImportRowSchema>;
export type PolicyImportPreview = z.infer<typeof policyImportPreviewSchema>;
export type PolicyImportReport = z.infer<typeof policyImportReportSchema>;
export type PolicyImportConfirm = z.infer<typeof policyImportConfirmSchema>;
export type PolicyImportResume = z.infer<typeof policyImportResumeSchema>;
export type PolicyImportStatus = z.infer<typeof policyImportStatusSchema>;
