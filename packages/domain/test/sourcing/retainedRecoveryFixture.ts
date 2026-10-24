import {createHash,randomUUID} from 'node:crypto';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {finishQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import type {RetainedIdentityDecisionInput,RetainedInterpretationInput,SourceObservation} from '@fss/contracts';
/** Controlled retained originals only. No request job, acquisition adapter or real company data. Caller owns transaction. */
export async function seedRetainedRecovery(ctx:RepositoryContext,suffix='',diagnostic=true){
 const firmName=`Retained Harbor PM${suffix}`,website=`https://retained-${randomUUID()}.example.test/`;
 const saved=await saveCandidate(ctx,{firmName:`${firmName} | Search heading`,website,sourceUrl:website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Controlled retained qualification fixture.',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled retained recovery acceptance'});
 if(!saved.ok)throw Error(saved.reason);
 const runId=randomUUID(),source:SourceObservation={id:randomUUID(),url:website,contentHash:'a'.repeat(64),relevantTextHash:'',retrievedAt:new Date(Date.now()-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[
  {id:'identity',text:`Copyright ${firmName}`},
  {id:'fit',text:`${firmName} is a residential property management company managing apartments in Dallas, TX.`},
  {id:'phone',text:`Contact ${firmName} at (214) 555-0186.`},
  {id:'need',text:'Our team is overwhelmed by maintenance vendor repair backlog.'},
  {id:'unrelated',text:'<img src="https://never-fetch.example.test/pixel"> Captured text only.'},
 ]};
 source.relevantTextHash=createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex');
 await ctx.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,requested_at)
 VALUES($1,$2,$3,1,$4,$5,$6,'controlled-original-no-provider',clock_timestamp()-interval '2 seconds')`,[ctx.scope.workspaceId,runId,saved.value.id,createHash('sha256').update(runId).digest('hex'),QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION]);
 const finished=await finishQualification(ctx,{runId,observations:[source],facts:[],reason:'invalid_evidence',...(diagnostic?{diagnostic:{version:'qualification-diagnostic-v1',phase:'extraction_rejected',fetchedPages:1,observations:1,completeFirstParty:1,truncatedObservations:0,skipped:{},extraction:{stage:'citation_roles',code:'identity_not_literal',selectionIndex:0,selectionCount:6,observationId:source.id,blockId:'identity'}}}: {})});
 if(!finished.ok)throw Error(finished.reason);
 const common={candidateId:saved.value.id,expectedRevision:1,qualificationRunId:runId},citation={observationId:source.id,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
 const identity:RetainedIdentityDecisionInput={...common,...citation,blockId:'identity',nameStart:10,nameEnd:10+firmName.length,decision:'confirm_literal_trade_name',acknowledged:'identity_only_not_qualification'};
 const interpretation=(decisionId:string):RetainedInterpretationInput=>({...common,expectedRevision:2,decisionId,acknowledged:'new_retained_interpretation_not_original_model_result',selections:[
  {kind:'firm_identity',blockId:'identity',...citation},{kind:'residential_management',blockId:'fit',...citation},{kind:'service_area',blockId:'fit',...citation},{kind:'business_phone',blockId:'phone',...citation},{kind:'operational_burden',blockId:'need',...citation},
 ]});
 return {candidateId:saved.value.id,runId,source,identity,interpretation,firmName,website};
}
