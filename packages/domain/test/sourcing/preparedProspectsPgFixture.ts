import {createHash,randomUUID} from 'node:crypto';
import type {CandidateInput,SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';

/** Fictional retained pages only. Seeding never calls acquisition or qualification. */
export async function seedPreparedProspect(ctx:RepositoryContext,index=1,options:{pages?:boolean;sourceAgeMs?:number;truncated?:boolean;firstParty?:boolean;region?:CandidateInput['region'];extraBlocks?:SourceObservation['blocks'];businessText?:string;omitBrand?:boolean;website?:string}={}){
 const website=options.website??`https://cedar-${index}-${randomUUID()}.example.test/`,name=`Cedar ${index} Property Management`,label=`Home | Cedar ${index} PM`;
 const input:CandidateInput={firmName:label,website,locality:'Boston',region:options.region??'MA',signal:'fit_only',
  evidence:'Retained discovery label; phone and business need unknown.',sourceUrl:website,
  observedOn:new Date().toISOString().slice(0,10),preparedBy:'Fictional prepared-company acceptance'};
 const saved=await withTransaction(ctx.db,()=>saveCandidate(ctx,input));if(!saved.ok)throw Error(saved.reason);
 const candidateId=saved.value.id;
 if(options.pages===false)return {candidateId,runId:null,candidateRevision:1,website,name,label,input,observations:[] as SourceObservation[]};
 const blocks=[...(options.omitBrand?[]:[{id:'brand',text:name}]),{id:'residential',text:options.businessText??`${name} manages residential homes in Boston, Massachusetts.`},
  {id:'workflow',text:'Our property managers coordinate maintenance requests and tenant communication for residential owners.'},
  {id:'territory',text:'This independently operated franchise office serves Boston. National network totals are not this office portfolio.'},...(options.extraBlocks??[])];
 const observations:SourceObservation[]=[{id:randomUUID(),url:website,contentHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),
  relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(Date.now()-(options.sourceAgeMs??1000)).toISOString(),
  publishedAt:null,publishedAtBlockId:null,firstParty:options.firstParty??true,truncated:options.truncated??false,blocks}];
 const runId=randomUUID();
 await ctx.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,state,reason,observations,facts,finished_at)
 VALUES($1,$2,$3,1,$4,'qualification-context-v7','qualification-v5','none','unavailable','invalid_evidence',$5,'[]',clock_timestamp())`,
 [ctx.scope.workspaceId,runId,candidateId,createHash('sha256').update(runId).digest('hex'),JSON.stringify(observations)]);
 return {candidateId,runId,candidateRevision:1,website,name,label,input,observations};
}

/** Whole business/provider rows expose accidental writes, including saved fit. */
export async function preparedProspectsBusinessSnapshot(ctx:RepositoryContext){
 const result:Record<string,unknown[]>={};
 for(const table of ['sourcing_candidates','sourcing_qualification_runs','sourcing_discovery_settings','sourcing_prospect_priorities','sourcing_prospect_considerations','sourcing_manual_prospect_states','jobs','provider_reservations','firms','contacts','phone_routes','email_addresses','sequence_enrollments','outbound_messages','sourcing_admissions','suppression_events'])
  result[table]=(await ctx.db.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`,[ctx.scope.workspaceId])).rows;
 return result;
}
