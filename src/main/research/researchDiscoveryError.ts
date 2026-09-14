import { ProviderError } from '../outreach/providers/providerValidation';
/** Invocation-local classification only. Never retain provider payloads or causes. */
const reasons = ['transport_uncertain', 'response_body_invalid', 'http_rejected', 'envelope_invalid',
  'search_receipt_invalid', 'output_invalid', 'candidate_json_invalid', 'citation_missing', 'consulted_source_missing'] as const;
export type ResearchDiscoveryReason = typeof reasons[number];
export type ResearchDiscoveryDiagnostic = { reason: ResearchDiscoveryReason; httpStatus?: number };
export class ResearchDiscoveryError extends ProviderError {
  constructor(readonly reason: ResearchDiscoveryReason, readonly httpStatus?: number) {
    // Keep the existing HTTP caller message/code while adding diagnostic metadata.
    const code = reason === 'transport_uncertain' ? 'network_uncertain'
      : reason === 'response_body_invalid' ? 'provider_response_invalid' : undefined;
    // Preserve safeError normalization in the desktop researchCompanies caller.
    super(code ?? 'provider_response_invalid');
    this.message = code ?? (reasons.includes(reason) ? reason : 'transport_uncertain');
    this.name = 'ResearchDiscoveryError';
  }
}
/** Rebuild the allowlisted record at emission. Even a mutated Error must not leak. */
export function researchDiscoveryDiagnostic(error: ResearchDiscoveryError): ResearchDiscoveryDiagnostic {
  const candidateReason = error.reason;
  const reason = reasons.includes(candidateReason) ? candidateReason : 'transport_uncertain';
  const status = error.httpStatus;
  return { reason, ...(reason === 'http_rejected' && typeof status === 'number' && Number.isInteger(status)
    && status >= 100 && status <= 599 && (status < 200 || status >= 300) ? { httpStatus: status } : {}) };
}
