import {randomUUID} from 'node:crypto';
import {targetingProposalSchema,type QualificationFact,type SourceObservation} from '@fss/contracts';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {databaseNow} from '../../policy/clock.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,finishQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import {saveTargetingProposal,applyTargetingProposal,readTargetingPolicy} from '../../sourcing/targetingProposals.ts';
import {VERIFIED_FIRM_POLICY_VERSION} from '../../sourcing/verifiedFirmPolicy.ts';

/** Author-only fixture until Root grants its one disposable PG lane. Every source,
 * query, original and approval below is fictional in that disposable database. No
 * provider/worker/capture is invoked; current owners write and read actual rows. */
export async function currentUSPreparedSupplyPgFixture(){
 const database=await createTestDatabase(),seed=await seedTwoWorkspaces(database.session),runtime=await database.appRuntimeSession();
 const w=seed.alpha.workspaceId,owner=seed.alpha.admin.userId;
 const admin=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),runtime);
 const worker=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),runtime);
 await database.session.query(`INSERT INTO sourcing_discovery_settings(workspace_id,owner_user_id,auto_admission_enabled,qualification_evaluation)
  VALUES($1,$2,true,$3::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET owner_user_id=$2,auto_admission_enabled=true,qualification_evaluation=$3::jsonb`,
 [w,owner,JSON.stringify({verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION,
  promptVersion:QUALIFICATION_PROMPT_VERSION,reportSha256:'e'.repeat(64),reviewedEligible:1,falseEligible:0})]);
 let slot=0;
 const prepared=async(action='provides')=>{
  const key=randomUUID(),now=await databaseNow(admin),host=`us-${key}.example.test`,website=`https://${host}/`;
  const firmName=`Synthetic Harbor ${key} LLC`,query={id:`fixture-${key}`,query:'Los Angeles California residential property management',locality:'Los Angeles',region:'CA' as const};
  const policy=await readTargetingPolicy(admin);
  const proposed=await withTransaction(runtime,()=>saveTargetingProposal(admin,targetingProposalSchema.parse({basePolicyVersion:policy.version,queryChanges:[query],
   rankOrder:policy.rankOrder,evidenceIds:[],rationale:'Controlled fictional current-US source fixture only.'})));
  if(!proposed.ok)throw new Error(`US fixture targeting proposal: ${proposed.reason}`);
  const applied=await withTransaction(runtime,()=>applyTargetingProposal(admin,{id:proposed.value.id,expectedRevision:proposed.value.revision}));
  if(!applied.ok)throw new Error(`US fixture targeting apply: ${applied.reason}`);
  const saved=await withTransaction(runtime,()=>saveCandidate(admin,{firmName,website,sourceUrl:website,locality:query.locality,region:query.region,
   signal:'fit_only',evidence:'Controlled fictional approved query hit.',observedOn:now.slice(0,10),preparedBy:'Tavily Basic search · not verified',discoveryQuery:query.query}));
  if(!saved.ok)throw new Error(`US fixture candidate: ${saved.reason}`);
  const candidateId=saved.value.id,attempt=randomUUID();
  await database.session.query(`INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query,policy_version,state,slot)
   VALUES($1,$2,$3,$4,$5,'complete',$6)`,[attempt,w,query.id,query.query,applied.value.policyVersion,slot++]);
  await database.session.query(`INSERT INTO sourcing_discovery_hits(workspace_id,source_url,attempt_id,candidate_id,native_result)
   VALUES($1,$2,$3,$4,$5::jsonb)`,[w,website,attempt,candidateId,JSON.stringify({url:website,title:firmName,snippet:'Fictional retained first-party result.'})]);
  const nativeText=`${firmName} ${action} residential property management in Los Angeles, California.`;
  const emailText=`Contact ${firmName} office in Los Angeles, CA at info@${host}.`;
  const nativeId=randomUUID(),emailId=randomUUID();
  const observation=(id:string,blockId:string,text:string):SourceObservation=>({id,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),
   retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:blockId,text}]});
  const observations=[observation(nativeId,'native',nativeText),
   {...observation(emailId,'email',emailText),url:`${website}contact`,contentHash:'c'.repeat(64)}];
  const facts:QualificationFact[]=[...(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value:nativeText,observationId:nativeId,blockId:'native'})),
   {kind:'business_email',value:emailText,observationId:emailId,blockId:'email'}];
  const requested=await withTransaction(runtime,()=>requestQualification(admin,{candidateId,expectedRevision:1},{enqueue:false}));
  if(!requested.ok)throw new Error(`US fixture qualification request: ${requested.reason}`);
  const runId=requested.value.runId;
  const finished=await withTransaction(runtime,()=>finishQualification(admin,{runId,observations,facts,reason:null,openingQuestion:null}));
  if(!finished.ok)throw new Error(`US fixture qualification completion: ${finished.reason}`);
  return {candidateId,runId,attempt,website,firmName,locality:query.locality,region:query.region,evidence:{now,facts,observations}};
 };
 return {database,runtime,seed,admin,worker,prepared,drop:()=>database.drop()};
}
