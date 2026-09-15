import { ProviderError, type ProviderErrorCode } from '../outreach/providers/providerValidation';
import { companyFactExtractionReason, companyFactExtractionCode, companyFactExtractionHttpStatus, type CompanyFactExtractionReason } from './companyFactExtraction';

export const companyResearchStages = Object.freeze(['snapshot', 'page', 'admission', 'cancelled', 'source_policy', 'dns', 'page_http', 'page_response', 'page_parse', 'source_receipt', 'model_request', 'fact_validation', 'evidence_batch'] as const);
export type CompanyResearchStage = typeof companyResearchStages[number];
const pageReasons = ['unknown', 'cancelled', 'timeout', 'source_required', 'extraction_unavailable', 'source_blocked', 'page_budget', 'bytes_exceeded', 'private_address', 'redirect_invalid', 'page_response_rejected', 'empty_page', 'no_permitted_pages', 'no_supported_facts', 'http_response_invalid'] as const;
const providerReasons = ['credentials_locked', 'credentials_corrupt', 'credentials_unavailable', 'invalid_configuration', 'model_unconfigured', 'gmail_unconfigured', 'gmail_reauthorize', 'provider_invalidated', 'provider_rejected', 'provider_response_invalid', 'network_uncertain', 'invalid_draft_context', 'ungrounded_output', 'oauth_cancelled', 'oauth_timeout', 'oauth_browser_failed', 'oauth_unavailable', 'oauth_denied', 'oauth_identity_invalid'] as const satisfies readonly ProviderErrorCode[];
const extractionReasons = ['response_json', 'envelope', 'response_incomplete', 'response_refusal', 'model', 'output_limit', 'message_count', 'fact_json', 'fact_schema', 'quote', 'model_credentials_invalid', 'model_credentials_mismatch'] as const;
export type CompanyResearchReason = typeof pageReasons[number] | ProviderErrorCode | CompanyFactExtractionReason;
export const companyResearchReasons = Object.freeze([...pageReasons, ...providerReasons, ...extractionReasons]);
export type CompanyResearchDiagnostic = { stage: CompanyResearchStage; reason: CompanyResearchReason; httpStatus?: number };
const provenance = new WeakMap<object, Readonly<CompanyResearchDiagnostic>>();
const intrinsicStages = new WeakSet<object>();
const pageMessages: Partial<Record<CompanyResearchReason, string>> = {
  source_required: 'Research permitted source required', extraction_unavailable: 'Known company extraction unavailable',
  source_blocked: 'Research blocked redirect or source', page_budget: 'Research page budget exceeded',
  bytes_exceeded: 'Research bytes exceeded', private_address: 'Research private address rejected',
  redirect_invalid: 'Research redirect invalid', page_response_rejected: 'Research page response rejected',
  empty_page: 'Research empty page', no_permitted_pages: 'Research no permitted pages',
  no_supported_facts: 'Research no supported facts', http_response_invalid: 'Research HTTP response invalid',
  cancelled: 'Research cancelled or timed out', timeout: 'Research cancelled or timed out',
};
function safeStage(stage: unknown): CompanyResearchStage {
  return companyResearchStages.find(value => value === stage) ?? 'page';
}
function safeReason(reason: unknown): CompanyResearchReason {
  return companyResearchReasons.find(value => value === reason) ?? 'unknown';
}
/** Contains only a fixed diagnostic, never the original exception or its cause. */
export class CompanyResearchError extends Error {
  constructor(stage: CompanyResearchStage, reason: CompanyResearchReason, httpStatus?: number) {
    super(pageMessages[safeReason(reason)] ?? 'Company research failed');
    const diagnostic: CompanyResearchDiagnostic = { stage: safeStage(stage), reason: safeReason(reason) };
    if (typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) diagnostic.httpStatus = httpStatus;
    provenance.set(this, Object.freeze(diagnostic));
    intrinsicStages.add(this);
  }
}
/** No message, name, reason, cause, stack, status, URL, or body from public fields. */
export function companyResearchDiagnostic(error: unknown, fallbackStage: CompanyResearchStage): CompanyResearchDiagnostic {
  const stage = safeStage(fallbackStage);
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    const branded = provenance.get(error);
    if (branded) return { ...branded };
  }
  const trustedCode = companyFactExtractionCode(error);
  if (trustedCode !== undefined) {
    const reason = companyFactExtractionReason(error) ?? trustedCode;
    const httpStatus = companyFactExtractionHttpStatus(error);
    return { stage, reason, ...(httpStatus === undefined ? {} : { httpStatus }) };
  }
  try {
    if (error instanceof ProviderError) {
      const code: unknown = error.code;
      const allowed = providerReasons.find(value => value === code);
      if (allowed) return { stage, reason: allowed };
    }
  } catch { /* Getters and proxy traps cannot break safe diagnostics. */ }
  return { stage, reason: 'unknown' };
}
/** Preserve every existing rejection identity/public behavior. Only safe metadata
 * is attached privately. Callers must log companyResearchDiagnostic, not errors. */
export function annotateCompanyResearchError<T>(error: T, stage: CompanyResearchStage, cancellation?: 'cancelled' | 'timeout'): T {
  const diagnostic = companyResearchDiagnostic(error, stage);
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    if (!intrinsicStages.has(error)) diagnostic.stage = safeStage(stage);
    if (cancellation === 'cancelled' || cancellation === 'timeout') { diagnostic.stage = safeStage(stage); diagnostic.reason = cancellation; delete diagnostic.httpStatus; }
    provenance.set(error, Object.freeze(diagnostic));
    return error;
  }
  // Primitives cannot carry identity-based metadata. Never retain their payloads.
  return error;
}
