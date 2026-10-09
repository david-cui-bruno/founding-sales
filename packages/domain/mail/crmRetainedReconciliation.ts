import type {RepositoryContext} from '../db/workspaceScope.ts';
import {repositoryContext,workspaceScope} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {lockIdentityContext} from '../crm/identityAccess.ts';
import {snapshotMailCopyAuthorityBatch,lockMailCopyAuthorityBatch,readMailCopyAvailabilityBatch,type ExactMailSource,type MailCopyAuthorityBatchSnapshot} from './crmSources.ts';
import {readBackfillAuthority,type BackfillAuthority} from './crmBackfillAuthority.ts';
interface Fence{authority:BackfillAuthority;jobId:string;leaseOwner:string;fencingToken:string}
interface Progress extends Record<string,unknown>{reconciliation_after_source_id:string|null;reconciliation_visited:string;reconciliation_exhausted:boolean}
export interface RetainedCopyTraversal{exact:ExactMailSource;messageId:string;snapshot:MailCopyAuthorityBatchSnapshot|null;progress:Progress;hasMore:boolean}
async function fence(context:RepositoryContext,input:Fence){
 if(context.scope.actor.kind!=='system'||context.scope.actor.component!=='worker')return false;
 return (await context.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[context.scope.workspaceId,input.jobId,input.leaseOwner,input.fencingToken])).rows.length===1;
}
async function ownerContext(context:RepositoryContext,input:Fence){
 const member=(await context.db.query<{role:string}>("SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[context.scope.workspaceId,input.authority.proof.ownerUserId])).rows[0];
 return member?.role==='admin'||member?.role==='salesperson'?repositoryContext(workspaceScope(context.scope.workspaceId,{kind:'user',userId:input.authority.proof.ownerUserId,role:member.role}),context.db):null;
}
/** One current older copy per short stage; UUID traversal does not freeze cohort membership. */
export async function prepareRetainedCopyTraversal(context:RepositoryContext,input:Fence){
 return withTransaction(context.db,async()=>{
  if(!await fence(context,input))return undefined;
  const owner=await ownerContext(context,input);if(owner===null)return undefined;
  const progress=(await context.db.query<Progress>('SELECT reconciliation_after_source_id,reconciliation_visited::text,reconciliation_exhausted FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,input.authority.importId])).rows[0];
  if(progress===undefined||progress.reconciliation_exhausted)return undefined;
  const proof=input.authority.proof;
  const rows=(await context.db.query<{source_id:string;source_revision:number;content_hash:string;provider_message_id:string}>(`SELECT s.source_id,s.source_revision,s.content_hash,c.provider_message_id FROM crm_mail_sources s JOIN crm_mail_capture_identities c ON c.workspace_id=s.workspace_id AND c.id=s.capture_identity_id WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.mailbox_id=$3 AND s.account_binding=$4 AND s.provider_account_id=$5 AND s.availability='available' AND s.provider_at<(SELECT from_at FROM crm_mail_imports WHERE workspace_id=$1 AND id=$6) AND ($7::uuid IS NULL OR s.source_id>$7) ORDER BY s.source_id LIMIT 2`,[context.scope.workspaceId,proof.ownerUserId,proof.mailboxId,proof.accountBinding,proof.providerAccountId,input.authority.importId,progress.reconciliation_after_source_id])).rows;
  const row=rows[0];
  if(row===undefined){
   const current=await readBackfillAuthority(context,input.authority.importId,true);
   if(current!==null&&JSON.stringify(current.proof)===JSON.stringify(proof))await context.db.query('UPDATE crm_mail_imports SET reconciliation_exhausted=true WHERE workspace_id=$1 AND id=$2 AND reconciliation_after_source_id IS NOT DISTINCT FROM $3::uuid AND reconciliation_visited=$4::numeric',[context.scope.workspaceId,input.authority.importId,progress.reconciliation_after_source_id,progress.reconciliation_visited]);
   return undefined;
  }
  const exact={sourceId:row.source_id,sourceRevision:row.source_revision,contentHash:row.content_hash};
  const availability=await readMailCopyAvailabilityBatch(owner,[exact.sourceId]);
  let snapshot=availability?.[0]?.availability==='available'&&availability[0].bodyAvailable?await snapshotMailCopyAuthorityBatch(owner,[exact]):null;
  if(snapshot!==null&&(!await lockIdentityContext(owner,{firmIds:snapshot.firmIds,personIds:snapshot.personIds})||!await lockMailCopyAuthorityBatch(owner,snapshot,{firmIds:snapshot.firmIds,personIds:snapshot.personIds,lockMode:'read'})))snapshot=null;
  await context.db.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.authority.importId]);
  const current=await readBackfillAuthority(context,input.authority.importId);
  if(current===null||JSON.stringify(current.proof)!==JSON.stringify(proof))return undefined;
  return {exact,messageId:row.provider_message_id,snapshot,progress,hasMore:rows.length>1} satisfies RetainedCopyTraversal;
 });
}
/** Unknown provider attempts do not advance unique-copy counters. Current binding and exact cursor CAS still fence progress. */
export async function completeRetainedCopyTraversal(context:RepositoryContext,input:Fence&{traversal:RetainedCopyTraversal;refreshed:boolean}){
 await withTransaction(context.db,async()=>{
  if(!await fence(context,input))return;
  const owner=await ownerContext(context,input);if(owner===null)return;
  const snapshot=input.traversal.snapshot;
  let unchanged=false;
  if(snapshot!==null&&await lockIdentityContext(owner,{firmIds:snapshot.firmIds,personIds:snapshot.personIds}))unchanged=await lockMailCopyAuthorityBatch(owner,snapshot,{firmIds:snapshot.firmIds,personIds:snapshot.personIds,lockMode:'read'});
  await context.db.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,input.authority.importId]);
  const current=await readBackfillAuthority(context,input.authority.importId);
  if(current===null||JSON.stringify(current.proof)!==JSON.stringify(input.authority.proof))return;
  const refreshed=input.refreshed&&unchanged;
  await context.db.query(`UPDATE crm_mail_imports SET reconciliation_after_source_id=$3,reconciliation_visited=reconciliation_visited+1,reconciliation_refreshed=reconciliation_refreshed+$4,reconciliation_unresolved=reconciliation_unresolved+$5,reconciliation_exhausted=$6
   WHERE workspace_id=$1 AND id=$2 AND reconciliation_after_source_id IS NOT DISTINCT FROM $7::uuid AND reconciliation_visited=$8::numeric AND NOT reconciliation_exhausted`,[context.scope.workspaceId,input.authority.importId,input.traversal.exact.sourceId,refreshed?1:0,refreshed?0:1,!input.traversal.hasMore,input.traversal.progress.reconciliation_after_source_id,input.traversal.progress.reconciliation_visited]);
 });
}
