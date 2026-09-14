import { ProviderError } from '../outreach/providers/providerValidation';
/** Invocation-local classification only. Never retain provider payloads or causes. */
const reasons = ['transport_uncertain', 'response_body_invalid', 'http_rejected', 'envelope_invalid',
  'search_receipt_invalid', 'output_invalid', 'candidate_json_invalid', 'citation_missing', 'consulted_source_missing'] as const;
export type ResearchDiscoveryReason = typeof reasons[number];
export type CitationSummary = { candidateCount: number; annotationCount: number; exactMatchCount: number;
  serializedMatchCount: number; consultedMatchCount: number };
export type ResearchDiscoveryDiagnostic = { reason: ResearchDiscoveryReason; httpStatus?: number; citationSummary?: CitationSummary };
/** Read each allowlisted property once. Never retain raw objects or serialization hooks. */
function copyCitationSummary(raw: unknown): CitationSummary | undefined {
  try {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const value = raw as Record<string, unknown>;
    const candidateCount = value.candidateCount;
    const annotationCount = value.annotationCount;
    const exactMatchCount = value.exactMatchCount;
    const serializedMatchCount = value.serializedMatchCount;
    const consultedMatchCount = value.consultedMatchCount;
    if (!boundedInteger(candidateCount, 1, 50) || !boundedInteger(annotationCount, 0, 100)
      || !boundedInteger(exactMatchCount, 0, candidateCount - 1)
      || !boundedInteger(serializedMatchCount, exactMatchCount, candidateCount)
      || !boundedInteger(consultedMatchCount, 0, candidateCount)
      || (annotationCount === 0 && serializedMatchCount !== 0)) return undefined;
    return { candidateCount, annotationCount, exactMatchCount, serializedMatchCount, consultedMatchCount };
  } catch { return undefined; }
}
function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
export class ResearchDiscoveryError extends ProviderError {
  readonly citationSummary?: CitationSummary;
  constructor(readonly reason: ResearchDiscoveryReason, readonly httpStatus?: number, citationSummary?: unknown) {
    // Keep the existing HTTP caller message/code while adding diagnostic metadata.
    const code = reason === 'transport_uncertain' ? 'network_uncertain'
      : reason === 'response_body_invalid' ? 'provider_response_invalid' : undefined;
    // Preserve safeError normalization in the desktop researchCompanies caller.
    super(code ?? 'provider_response_invalid');
    this.message = code ?? (reasons.includes(reason) ? reason : 'transport_uncertain');
    this.name = 'ResearchDiscoveryError';
    if (reason === 'citation_missing') {
      const safeSummary = copyCitationSummary(citationSummary);
      if (safeSummary) this.citationSummary = safeSummary;
    }
  }
}
/** Rebuild the allowlisted record at emission. Even a mutated Error must not leak. */
export function researchDiscoveryDiagnostic(error: ResearchDiscoveryError): ResearchDiscoveryDiagnostic {
  let candidateReason: unknown;
  try { candidateReason = error.reason; } catch { /* Fall back to the existing safe reason. */ }
  const reason = reasons.includes(candidateReason as ResearchDiscoveryReason) ? candidateReason as ResearchDiscoveryReason : 'transport_uncertain';
  const diagnostic: ResearchDiscoveryDiagnostic = { reason };
  if (reason === 'http_rejected') {
    try {
      const status = error.httpStatus;
      if (boundedInteger(status, 100, 599) && (status < 200 || status >= 300)) diagnostic.httpStatus = status;
    } catch { /* Hostile metadata is not diagnostic evidence. */ }
  }
  if (reason === 'citation_missing') {
    try {
      const summary = copyCitationSummary(error.citationSummary);
      if (summary) diagnostic.citationSummary = summary;
    } catch { /* The summary itself may be a hostile accessor. */ }
  }
  return diagnostic;
}
