import { crmExtractionSourceScopeSchema, type CrmExtractionSourceScope } from '@fss/contracts';

/** Syntax is not owner/account/epoch authority. Callers separately revalidate
 * the bound capture approval before any original read or model dispatch.
 */
export function crmExtractionSourceAllowed(scope: CrmExtractionSourceScope, kind: string): boolean {
  const parsed = crmExtractionSourceScopeSchema.safeParse(scope);
  return parsed.success && kind === 'mail' && parsed.data.allowedSourceKinds.length === 1
    && parsed.data.mailCaptureOwnerApprovalId !== null;
}
