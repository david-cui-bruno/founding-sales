import { type CRM_OWNER_SCOPE_VERSION, crmCapabilityReadResponseSchema, crmExtractionPurposeSchema } from '@fss/contracts';

/** Scope is explicit protocol negotiation, never inferred from a forged version
 * header. Already shipped strict clients keep exact outer AND nested shapes.
 */
export function projectCrmCapabilityRead(value: unknown, scopeVersion?: typeof CRM_OWNER_SCOPE_VERSION) {
  const parsed = crmCapabilityReadResponseSchema.parse(value);
  if (scopeVersion) return { ...parsed, scopeVersion };
  const { scopeVersion: _scopeVersion, ...legacy } = parsed;
  const c = legacy.configuration;
  if (c?.capability === 'mail_capture') {
    const { forwardScope: _forwardScope, ...configuration } = c;
    return { ...legacy, configuration };
  }
  if (c?.capability === 'crm_extraction') {
    const { allowedSourceKinds: _kinds, mailCaptureOwnerApprovalId: _approval, ...configuration } = c;
    return { ...legacy, configuration };
  }
  return legacy;
}

export function projectCrmExtractionPurpose(value: unknown, scopeVersion?: typeof CRM_OWNER_SCOPE_VERSION) {
  const parsed = crmExtractionPurposeSchema.parse(value);
  if (scopeVersion) return { ...parsed, scopeVersion };
  const { scopeVersion: _scopeVersion, ...legacy } = parsed;
  if (!legacy.configured) return legacy;
  const { allowedSourceKinds: _kinds, mailCaptureOwnerApprovalId: _approval, ...configuration } = legacy;
  return configuration;
}
