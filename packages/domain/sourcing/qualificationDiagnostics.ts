/** Internal, content-free qualification diagnostics. Never an admission or retry reason. */
export const QUALIFICATION_DIAGNOSTIC_PHASES = [
  'fetch_failed', 'fetch_exception', 'no_observations', 'observations_over_bound',
  'no_complete_first_party', 'unoffered_observation', 'evidence_rejected',
] as const;
export type QualificationDiagnosticPhase = typeof QUALIFICATION_DIAGNOSTIC_PHASES[number];

/** Explicit fetcher outcomes only. Unrecognized keys and provider text are discarded. */
export const QUALIFICATION_FETCH_SKIP_CODES = [
  'paused', 'page_budget_reached', 'firm_timeout', 'url_not_permitted',
  'address_not_public', 'robots_unreadable', 'robots_disallowed', 'request_failed',
  'redirect_limit', 'malformed_redirect', 'url_has_query', 'page_over_bound',
  'status_401', 'status_403', 'status_404', 'status_410', 'status_429',
  'status_500', 'status_502', 'status_503', 'status_504', 'status_other',
] as const;
export type QualificationFetchSkipCode = typeof QUALIFICATION_FETCH_SKIP_CODES[number];

/** Construct and validate at the persistence boundary. Counts are finite bounded integers. */
export interface QualificationDiagnostic {
  readonly version: 'qualification-diagnostic-v1';
  readonly phase: QualificationDiagnosticPhase;
  readonly fetchedPages: number;
  readonly observations: number;
  readonly completeFirstParty: number;
  readonly truncatedObservations: number;
  readonly skipped: Readonly<Partial<Record<QualificationFetchSkipCode, number>>>;
}
