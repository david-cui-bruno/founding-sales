import {isDeepStrictEqual} from 'node:util';
import {prospectPhoneRefusalOriginalInputSchema,prospectPhoneRefusalOriginalSchema,type ProspectPhoneRefusalOriginalInput,type ProspectPhoneRefusalOriginal,type ProspectPhoneDiscoveryView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readProspectPhoneDiscoverySnapshot} from './prospectPhoneDiscovery.ts';
import type {PhoneDiscoveryAuthority} from './prospectPhoneDiscoveryAuthority.ts';
import {projectProspectPhoneDiscovery} from './prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from './prospectPhoneDiscoveryStore.ts';

type Snapshot={view:ProspectPhoneDiscoveryView;run:PhoneDiscoveryRun;now:number};
type Result={ok:true;value:ProspectPhoneRefusalOriginal}|{ok:false;reason:string};
const changed=():Result=>({ok:false,reason:'source_changed'});
function selected(snapshot:Snapshot,input:ProspectPhoneRefusalOriginalInput,now:number):ProspectPhoneRefusalOriginal|null{
 const {view,run}=snapshot;
 if(view.candidateId!==input.candidateId||view.candidateRevision!==input.expectedRevision||view.runId!==input.runId||view.state!=='complete'||
  run.id!==input.runId||run.candidate_id!==input.candidateId||run.candidate_revision!==input.expectedRevision||run.state!=='complete'||!run.content||
  run.expires_at.getTime()<=now||Date.parse(view.expiresAt)<=now)return null;
 const evidence=view.phoneEvidence;
 if(evidence.state!=='conflicting'||evidence.diagnostics?.expiresAt&&Date.parse(evidence.diagnostics.expiresAt)<=now)return null;
 const matches=evidence.diagnostics?.entries.filter(entry=>entry.runId===input.runId&&entry.observationId===input.observationId&&entry.blockId===input.blockId&&
  entry.labelStart===input.labelStart&&entry.labelEnd===input.labelEnd&&entry.reason===input.reason)??[];
 if(matches.length!==1)return null;
 const location=matches[0]!;
 if(location.authority.kind!=='phone_discovery'||location.authority.runId!==input.runId||location.lineage.kind!=='provider_original'||Date.parse(location.authority.expiresAt)<=now)return null;
 // Reuse the unchanged whole-run scanner. A damaged other block cannot leave
 // this selected prefix available even if the caller still holds an old DTO.
 const discovered=projectProspectPhoneDiscovery(run,now);
 if(discovered.state!=='conflicting'||!discovered.diagnostics?.entries.some(entry=>isDeepStrictEqual(entry,location)))return null;
 const observation=run.content.observations.find(source=>source.id===input.observationId);
 const block=observation?.blocks.find(value=>value.id===input.blockId);
 if(!observation||!block||observation.url!==location.url||observation.contentHash!==location.contentHash||observation.relevantTextHash!==location.relevantTextHash||observation.retrievedAt!==location.retrievedAt)return null;
 const result=prospectPhoneRefusalOriginalSchema.safeParse({candidateId:input.candidateId,candidateRevision:input.expectedRevision,location,text:block.text,purpose:'manual_refusal_review',channelAuthority:'not_granted'});
 return result.success?result.data:null;
}
/** Caller owns the current read transaction and its ordinary source/principal locks.
 * No acquisition, receipt, persistence, historical lookup or retention renewal. */
export async function readProspectPhoneRefusalOriginal(ctx:RepositoryContext,input:ProspectPhoneRefusalOriginalInput,authority:PhoneDiscoveryAuthority=async()=>true):Promise<Result>{
 if(!prospectPhoneRefusalOriginalInputSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 const binding={candidateId:input.candidateId,expectedRevision:input.expectedRevision};
 const first=await readProspectPhoneDiscoverySnapshot(ctx,binding,authority);
 if(!first.ok)return first;
 if(!first.value)return changed();
 const before=selected(first.value,input,first.value.now);
 if(!before)return changed();
 const last=await readProspectPhoneDiscoverySnapshot(ctx,binding,authority);
 if(!last.ok)return last;
 if(!last.value||!isDeepStrictEqual(first.value.view,last.value.view)||!isDeepStrictEqual(first.value.run,last.value.run))return changed();
 // No new awaits after the current read's final clock and locked rechecks.
 const value=selected(last.value,input,last.value.now);
 return value&&isDeepStrictEqual(before,value)?{ok:true,value}:changed();
}
