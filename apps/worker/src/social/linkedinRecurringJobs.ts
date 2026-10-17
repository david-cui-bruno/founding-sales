import type {LinkedinPostingPolicySnapshot} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {readAppliedSchemaVersion} from '@fss/domain/db/migrationRunner.ts';
import {REQUIRED_SCHEMA} from '@fss/domain/db/schemaRange.ts';
import type {SocialDraftPort} from '@fss/domain/social/draftRun.ts';
import {prepareLinkedinRecurringSlots,runLinkedinRecurringSlot} from '@fss/domain/social/linkedinRecurringPosting.ts';
import {linkedinRecurringScopeReason,type LinkedinRecurringComposition} from '@fss/domain/social/linkedinRecurringAuthority.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
/** Trusted process composition, never an HTTP setting or a candidate permission.
 * Startup supplies no composition. External transport/account observations are evidence
 * of this composition only, not semantic quality, installed acceptance or Enable. */
export async function createLinkedinRecurringComposition(input:{session:SessionQueryable;workspaceId:string;ownerUserId:string;accountId:string;policyRevision:number;generation:NonNullable<LinkedinPostingPolicySnapshot['generation']>;expiresAt:string;clock:{now():string};model:SocialDraftPort;inspectAccount():Promise<{platform:string;externalId:string}|null>}):Promise<LinkedinRecurringComposition|null>{
 const db=input.session;
 const c=(await db.query<{name:string;address:string;port:number;role:string;superuser:boolean}>(`SELECT current_database() AS name,host(inet_server_addr()) AS address,inet_server_port() AS port,current_user AS role,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`)).rows[0];
 if(!c||c.role!=='app_runtime'||c.superuser||!c.name||!c.address||!c.port||await readAppliedSchemaVersion(db)!==REQUIRED_SCHEMA||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.now()||Date.parse(input.expiresAt)>Date.now()+300000)return null;
 let identity:{platform:string;externalId:string}|null;try{identity=await input.inspectAccount();}catch{return null;}
 if(identity?.platform!=='linkedin'||identity.externalId!=='david-cui-589a20228')return null;
 const account=(await db.query<{revision:number}>("SELECT revision FROM social_accounts WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND platform='linkedin' AND external_id=$4 AND state='connected'",[input.workspaceId,input.accountId,input.ownerUserId,identity.externalId])).rows[0];if(!account)return null;
 const composition:LinkedinRecurringComposition=Object.freeze({workspaceId:input.workspaceId,ownerUserId:input.ownerUserId,accountId:input.accountId,accountRevision:account.revision,policyRevision:input.policyRevision,generation:Object.freeze({...input.generation}),expiresAt:input.expiresAt,databaseName:c.name,serverAddress:c.address,serverPort:c.port,model:input.model,clock:input.clock});
 const ctx=repositoryContext(workspaceScope(input.workspaceId,{kind:'system',component:'worker'}),db);
 return await withTransaction(db,()=>linkedinRecurringScopeReason(ctx,{owner_user_id:input.ownerUserId,account_id:input.accountId,account_revision:account.revision,policy_revision:input.policyRevision},composition))===null?composition:null;
}
export function linkedinRecurringHandler(runtime?:LinkedinRecurringComposition|null):JobHandler{return {kind:'social.linkedin_recurring',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,handle:async input=>{const id=input.job.payload['slotId'];if(typeof id==='string')await runLinkedinRecurringSlot(repositoryContext(input.scope,input.session),id,runtime);}};}
export function linkedinRecurringSource(runtime?:LinkedinRecurringComposition|null):DueWorkSource{return {name:'linkedin-recurring',find:async(session,at)=>{
 const workspaces=(await session.query<{workspace_id:string}>("SELECT DISTINCT workspace_id FROM linkedin_posting_settings WHERE state='saved' ORDER BY workspace_id LIMIT 25")).rows;
 const jobs:JobSpecification[]=[];
 for(const {workspace_id:workspace} of workspaces){
  const ctx=repositoryContext(workspaceScope(workspace,{kind:'system',component:'scheduler'}),session);
  for(const slot of await prepareLinkedinRecurringSlots(ctx,at,runtime)){
   const draft=(await session.query<{state:string}>('SELECT state FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[workspace,slot.draft_request_id])).rows[0];
   jobs.push({workspaceId:workspace,kind:'social.linkedin_recurring',idempotencyKey:`linkedin-recurring:${slot.account_id}:${slot.target_at.toISOString()}:${draft?.state==='ready'?'admit':'draft'}`,payload:{slotId:slot.id},maxAttempts:1});
  }
 }
 return jobs;
}};}
