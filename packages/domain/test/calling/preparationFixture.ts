import {createHash,randomUUID} from 'node:crypto';
import type {ManualPhoneChoice,CallingPreparationInput} from '@fss/contracts';
import type {SessionQueryable} from '../../db/queryable.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {recordManualProspectFeedback} from '../../sourcing/manualProspects.ts';
import {manualOrdinaryFixture} from '../sourcing/support/manualProspectFixture.ts';
import {confirmCallingPreparation} from '../../calling/preparation.ts';

export async function callingPreparationFixture(){
 const database=await createTestDatabase(),seed=await seedTwoWorkspaces(database.session),runtime=await database.appRuntimeSession();
 return {database,seed,runtime,...callingPreparationSources(runtime,seed),stop:()=>database.drop()};
}
export function callingPreparationSources(runtime:SessionQueryable,seed:{alpha:{workspaceId:string;admin:{userId:string};salesperson:{userId:string}}}){
 const ctx=(session:SessionQueryable=runtime,role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seed.alpha.workspaceId,
  {kind:'user',userId:seed.alpha[role].userId,role}),session);
 const tx=<T>(work:()=>Promise<T>,session=runtime)=>withTransaction(session,work);
 let serial=90000;
 async function source(){
  const raw=manualOrdinaryFixture(++serial);raw.sourceUrl=`${raw.website}about`;
  const saved=await tx(()=>saveCandidate(ctx(),raw));if(!saved.ok)throw Error(saved.reason);
  const runId=randomUUID(),observationId=randomUUID(),text=`Office phone: (401) 555-01${String(serial%100).padStart(2,'0')}`;
  const requestedAt=new Date(Date.now()-1000).toISOString(),content={website:raw.website,sourceUrls:[raw.sourceUrl],observations:[]};
  await runtime.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,requested_at,deadline_at,expires_at,content)
   VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1','pending',$5,$5::timestamptz+interval '30 minutes',$5::timestamptz+interval '1 hour',$6::jsonb)`,
  [seed.alpha.workspaceId,runId,saved.value.id,seed.alpha.admin.userId,requestedAt,JSON.stringify(content)]);
  await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE id=$1",[runId]);
  const blocks=[{id:'office',text}],observation={id:observationId,url:`${raw.website}contact`,contentHash:createHash('sha256').update(text).digest('hex'),
   relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
  await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$2::jsonb WHERE id=$1",[runId,JSON.stringify({...content,observations:[observation]})]);
  const choice:ManualPhoneChoice={runId,observationId,blockId:'office',labelStart:0,labelEnd:12,start:14,end:text.length,contentHash:observation.contentHash,relevantTextHash:observation.relevantTextHash};
  const selection={candidateId:saved.value.id,expectedCandidateRevision:1,choice};
  const kept=await tx(()=>recordManualProspectFeedback(ctx(),{candidateId:saved.value.id,expectedRevision:1,state:'kept',phoneChoice:choice}));if(!kept.ok)throw Error(kept.reason);
  const input:CallingPreparationInput={selection,expected:{state:'absent'},reviewedProfile:{companyName:raw.firmName,website:raw.website,
   addressLine:'10 Fictional Office Way',locality:'Dallas',regionCode:'TX',postalCode:'75001',countryCode:'US',timeZone:{kind:'reviewed',timeZone:'America/Chicago'}},acknowledgeUnqualifiedSourceOwnership:true};
  return {input,raw,runId};
 }
 async function prepared(){const f=await source(),answer=await tx(()=>confirmCallingPreparation(ctx(),f.input,async()=>true));if(!answer.ok)throw Error(answer.reason);return {...f,...answer.value};}
 return {ctx,tx,source,prepared};
}
