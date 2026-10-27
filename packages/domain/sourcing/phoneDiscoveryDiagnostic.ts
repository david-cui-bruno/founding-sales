/** Operational codes only. Never retain source URLs, text, provider codes or errors. */
export type PhoneDiscoveryStage='claim'|'authority'|'fetch_or_authority'|'clock'|'parse'|'finalize';
export type PhoneDiscoveryDiagnostic={
 readonly branch:'authority_refused'|'provider_failed'|'empty_pages'|'observation_invalid'|'exception';
 readonly stage:PhoneDiscoveryStage;
 readonly pages:number;
 readonly skipped:Readonly<Record<string,number>>;
};
const skipNames=['address_not_public','url_not_permitted','robots_disallowed','robots_unreadable','redirect_limit','malformed_redirect','url_has_query','request_failed','firm_timeout','page_over_bound','page_budget_reached','paused','source_authority_refused'] as const;
const bounded=(value:number):number=>Number.isSafeInteger(value)&&value>0?Math.min(value,1000):0;
export function phoneDiscoveryDiagnostic(branch:PhoneDiscoveryDiagnostic['branch'],stage:PhoneDiscoveryStage,pages=0,skipped:Readonly<Record<string,number>>={}):PhoneDiscoveryDiagnostic{
 const counts:Record<string,number>={};
 // Keep safe counter names outside the logger's credential/URL-name redaction.
 for(const name of skipNames){const count=bounded(skipped[name]??0);if(count)counts[name==='url_not_permitted'?'policy_refused':name==='url_has_query'?'query_refused':name]=count;}
 for(const family of [4,5]){
  let count=0;
  for(let status=family*100;status<(family+1)*100;status++)count=Math.min(1000,count+bounded(skipped[`status_${status}`]??0));
  if(count)counts[`http_${family}xx`]=count;
 }
 return {branch,stage,pages:bounded(pages),skipped:counts};
}
