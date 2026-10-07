/** One Basic search; research fan-out is capped independently from result retrieval. */
export const DISCOVERY_RESULT_LIMIT=20;
export const DISCOVERY_NEW_CANDIDATE_LIMIT=5;
/** Search proposes URLs; none of these fields establishes a verified firm or need. */
export interface DiscoveryHit {readonly url:string;readonly title:string;readonly snippet:string}
export type DiscoverySearchResult =
 | {readonly ok:true;readonly credits:number;readonly requestId:string;readonly hits:readonly DiscoveryHit[]}
 | {readonly ok:false;readonly code:'invalid_query'|'invalid_response'|'usage_unexpected'|'auth_failed'|'quota_exhausted'|'rate_limited'|'unavailable'};
export interface DiscoverySearchProvider {
 readonly providerKey:string;
 /** Caller must durably reserve the attempt before invoking the provider. No retry is implied. */
 discover(input:{readonly query:string}):Promise<DiscoverySearchResult>;
}
