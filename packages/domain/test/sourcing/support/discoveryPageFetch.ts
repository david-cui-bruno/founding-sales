import type {PageFetchProvider,PageFetchRequest} from '../../../research/providers.ts';

/** A list-page read that is always refused: list hits yield no leads. */
export const refusingPageFetch:PageFetchProvider={providerKey:'fixture',fetchPages:async()=>({ok:false,failureCode:'fixture_refused',costCents:0})};

/** Serves fixed HTML by exact URL and records every request; an unknown URL is refused. */
export function htmlPageFetch(pages:Readonly<Record<string,string>>):PageFetchProvider&{readonly requests:PageFetchRequest[]} {
 const requests:PageFetchRequest[]=[];
 return {providerKey:'fixture',requests,fetchPages:async request=>{
  requests.push(request);
  const url=request.urls[0]!,html=pages[url];
  if(html===undefined)return {ok:false,failureCode:'fixture_refused',costCents:0};
  return {ok:true,costCents:0,value:{pages:[{url,contentHash:'a'.repeat(64),contentType:'text/html; charset=utf-8',body:new TextEncoder().encode(html),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}};
 }};
}
