import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordEvidence} from '../crm/evidence.ts';
import {parsePageText} from './pageText.ts';
import type {FactSource} from './facts.ts';
import type {FetchedPage} from './providers.ts';
/** Legacy page collection, unchanged options, detail and provenance. */
export async function collectResearchPages(context:RepositoryContext,firmId:string,pages:readonly FetchedPage[],bump:(reason:string)=>void){
 let evidenceRecorded=0;
 const sources:FactSource[]=[];
 const evidenceByReference=new Map<string,{readonly id:string;readonly retrievedAt:string}>();
 for(const page of pages){
  const parsed=parsePageText(page.body,page.contentType);
  if(parsed.blocks.length===0){bump(parsed.truncated?'page_over_bound':'page_unreadable');continue;}
  const evidence=await recordEvidence(context,{firmId,provider:'company_page',sourceReference:page.url,contentHash:page.contentHash,retrievedAt:new Date(page.retrievedAt),detail:{kind:'company_page',blocks:parsed.blocks.length,truncated:parsed.truncated}});
  if(!evidence.ok){bump(`evidence_${evidence.reason}`);continue;}
  evidenceRecorded++;
  sources.push({sourceReference:page.url,blocks:parsed.blocks,firstParty:page.firstParty});
  evidenceByReference.set(page.url,{id:evidence.value.id,retrievedAt:page.retrievedAt});
 }
 return {evidenceRecorded,sources,evidenceByReference};
}
