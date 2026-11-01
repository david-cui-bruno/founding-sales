import {randomUUID} from 'node:crypto';
import {candidateSchema} from '@fss/contracts';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {runDiscovery} from '../../sourcing/discovery.ts';
import {requestQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import {VERIFIED_FIRM_POLICY_VERSION} from '../../sourcing/verifiedFirmPolicy.ts';
import {refusingPageFetch} from './support/discoveryPageFetch.ts';

/** Fictional search/page inputs only. The caller owns the one disposable PG grant. */
export async function preparedSourceIdentityPgFixture(){
 const database=await createTestDatabase();
 try{
 const seed=await seedTwoWorkspaces(database.session),runtime=await database.appRuntimeSession();
 const workspace=seed.alpha.workspaceId,owner=seed.alpha.admin.userId;
 const admin=repositoryContext(workspaceScope(workspace,{kind:'user',userId:owner,role:'admin'}),runtime);
 const worker=repositoryContext(workspaceScope(workspace,{kind:'system',component:'worker'}),runtime);
 const website=`https://identity-${randomUUID()}.example.test/`,name='Synthetic Harbor Property Management',label='Home | HPM';
 const evaluation={verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,reportSha256:'e'.repeat(64),reviewedEligible:2,falseEligible:0};
 await runtime.query(`INSERT INTO sourcing_discovery_settings(workspace_id,enabled,query_cursor,owner_user_id,auto_admission_enabled,qualification_evaluation)
  VALUES($1,true,2,$2,true,$3::jsonb)`,[workspace,owner,JSON.stringify(evaluation)]);
 await runtime.query('INSERT INTO sourcing_search_account(id) VALUES(true)');
 let searchCalls=0;
 await runDiscovery(worker,{providerKey:'tavily_basic',discover:async()=>{searchCalls++;return {ok:true,credits:1,requestId:'fictional-identity-search',hits:[{url:website,title:label,snippet:'Fictional residential property management in Boston.'}]};}},refusingPageFetch);
 // Current automatic sourcing intentionally hides fresh needs_review rows from
 // the human review list. Inspect the one actual stored intake row here.
 const acquired=(await runtime.query<{id:string;revision:number;status:string;created_at:Date;payload:unknown}>('SELECT id,revision,status,created_at,payload FROM sourcing_candidates WHERE workspace_id=$1',[workspace])).rows;
 if(acquired.length!==1)throw Error('Expected one fictional acquired candidate');
 const row=acquired[0]!;if(typeof row.payload!=='object'||row.payload===null)throw Error('Expected candidate payload');
 const candidate=candidateSchema.parse({...row.payload,id:row.id,status:row.status,revision:row.revision,createdAt:row.created_at.toISOString()});
 const candidateBytes=async()=>(await runtime.query<{value:string}>('SELECT to_jsonb(c)::text value FROM sourcing_candidates c WHERE workspace_id=$1 AND id=$2',[workspace,candidate.id])).rows[0]!.value;
 const hitBytes=async()=>(await runtime.query<{value:string}>('SELECT to_jsonb(h)::text value FROM sourcing_discovery_hits h WHERE workspace_id=$1 AND candidate_id=$2',[workspace,candidate.id])).rows[0]!.value;
 const request=async(context=worker)=>{
  const result=await withTransaction(runtime,()=>requestQualification(context,{candidateId:candidate.id,expectedRevision:1},{enqueue:false}));
  if(!result.ok)throw Error(result.reason);return result.value.runId;
 };
 const run=async(runId:string)=>(await runtime.query<{producer_version:string;prepared_identity:unknown;state:string;reason:string|null;fingerprint:string;observations:unknown[];facts:unknown[]}>('SELECT producer_version,prepared_identity,state,reason,fingerprint,observations,facts FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[workspace,runId])).rows[0]!;
 const publication=async()=>(await runtime.query<{id:string;firm_id:string;run_id:string}>('SELECT id,firm_id,run_id FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND candidate_id=$2',[workspace,candidate.id])).rows[0]??null;
 const backupAdmin=()=>database.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspace,seed.alpha.salesperson.userId]);
 const deactivateOwner=async()=>{await backupAdmin();await database.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[workspace,owner]);};
 return {database,runtime,seed,workspace,owner,admin,worker,website,name,label,candidate,searchCalls,evaluation,request,run,publication,candidateBytes,hitBytes,backupAdmin,deactivateOwner,drop:()=>database.drop()};
 }catch(error){await database.drop();throw error;}
}
