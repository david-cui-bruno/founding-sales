import {MAX_PAGES_CEILING} from '../research/sourcePolicy.ts';

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

const boundedCount = (value:unknown,maximum:number):value is number =>
  typeof value==='number' && Number.isSafeInteger(value) && value>=0 && value<=maximum;
const record = (value:unknown):value is Record<string,unknown> =>
  typeof value==='object' && value!==null && !Array.isArray(value);

/** Unknown codes and invalid counts are dropped, never copied into durable audit. */
function normalizeSkipped(value:unknown):QualificationDiagnostic['skipped'] {
  const skipped:Partial<Record<QualificationFetchSkipCode,number>>={};
  if(!record(value))return skipped;
  let other=0;
  // Read a fixed key space, not arbitrary provider keys or their getters.
  for(const key of QUALIFICATION_FETCH_SKIP_CODES){
    if(!Object.hasOwn(value,key))continue;
    const count=value[key];
    if(!boundedCount(count,10000))continue;
    if(key==='status_other')other+=count;
    else skipped[key]=count;
  }
  for(let status=100;status<=599;status++){
    const key=`status_${status}`;
    if(QUALIFICATION_FETCH_SKIP_CODES.some(code=>code===key) || !Object.hasOwn(value,key))continue;
    const count=value[key];
    if(boundedCount(count,10000))other+=count;
  }
  // An overflowing combined HTTP bucket is omitted rather than undercounted.
  if(other>0 && boundedCount(other,10000))skipped.status_other=other;
  return skipped;
}

/** Reconstruct only the fixed DTO. Malformed diagnostics must never change a run.
 * The source/configuration ceiling is eight pages (the current approved default
 * is four). Never clamp a larger capture into a misleading four-page report.
 * Catch hostile property access too: auxiliary diagnostics cannot break finishing.
 */
export function normalizeQualificationDiagnostic(value:unknown):QualificationDiagnostic|undefined {
  try{
    if(!record(value))return undefined;
    const phase=value['phase'];
    if(value['version']!=='qualification-diagnostic-v1' ||
      !QUALIFICATION_DIAGNOSTIC_PHASES.some(allowed=>allowed===phase) || !record(value['skipped']))return undefined;
    const pages=value['fetchedPages'],observations=value['observations'];
    const complete=value['completeFirstParty'],truncated=value['truncatedObservations'];
    if(!boundedCount(pages,MAX_PAGES_CEILING) || !boundedCount(observations,MAX_PAGES_CEILING) ||
      !boundedCount(complete,observations) || !boundedCount(truncated,observations) ||
      observations>pages || complete+truncated>observations)return undefined;
    return {version:'qualification-diagnostic-v1',phase:phase as QualificationDiagnosticPhase,
      fetchedPages:pages,observations,completeFirstParty:complete,truncatedObservations:truncated,
      skipped:normalizeSkipped(value['skipped'])};
  }catch{return undefined;}
}
