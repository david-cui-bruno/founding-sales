import {readBackfillAuthority} from './crmBackfillAuthority.ts';
import type {MailCaptureProof} from './crmSources.ts';
import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
export type BackfillReadMethod='profile'|'list'|'history'|'metadata'|'body';
export interface BackfillAllocation extends Record<string,unknown>{
 workspace_id:string;mailbox_id:string;revision:number;owner_user_id:string;account_binding:string;generation:number;
 project_hash:string;user_hash:string;user_limit_units:number;project_limit_units:number;user_headroom_units:number;project_headroom_units:number;
 profile_units:number;list_units:number;history_units:number;metadata_units:number;body_units:number;verification_sha256:string;verified_until:Date;
}
export interface BackfillAllocationVerifier{verify(allocation:BackfillAllocation):Promise<boolean>}
export async function readBackfillAllocation(context:RepositoryContext,mailboxId:string){
 return (await context.db.query<BackfillAllocation>('SELECT * FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2',[context.scope.workspaceId,mailboxId])).rows[0]??null;
}
function fingerprint(row:BackfillAllocation){return createHash('sha256').update(JSON.stringify(row)).digest('hex');}
/** Call only outside a caller-owned transaction: arbitrary receipt verification precedes short reservation locks. */
export async function reserveBackfillRead(context:RepositoryContext,input:{importId:string;mailboxId:string;ownerUserId:string;accountBinding:string;generation:number;method:BackfillReadMethod;expectedProof:MailCaptureProof;jobId:string;leaseOwner:string;fencingToken:string},verifier:BackfillAllocationVerifier){
 const before=await readBackfillAllocation(context,input.mailboxId);
 if(before===null||before.owner_user_id!==input.ownerUserId||before.account_binding!==input.accountBinding||before.generation!==input.generation||!await verifier.verify(before))return null;
 return withTransaction(context.db,async()=>{
  const actor=context.scope.actor;if(actor.kind!=='system'||actor.component!=='worker')return null;
  const leased=await context.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[context.scope.workspaceId,input.jobId,input.leaseOwner,input.fencingToken]);
  if(!leased.rows.length)return null;
  const authority=await readBackfillAuthority(context,input.importId,true);
  if(authority===null||JSON.stringify(authority.proof)!==JSON.stringify(input.expectedProof))return null;
  const current=(await context.db.query<BackfillAllocation>('SELECT * FROM crm_mail_import_allocations WHERE workspace_id=$1 AND mailbox_id=$2 AND verified_until>clock_timestamp() FOR SHARE',[context.scope.workspaceId,input.mailboxId])).rows[0];
  if(current===undefined||fingerprint(current)!==fingerprint(before))return null;
  const imported=await context.db.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2 AND mailbox_id=$3 AND owner_user_id=$4 AND account_binding=$5 AND generation=$6',[context.scope.workspaceId,input.importId,input.mailboxId,input.ownerUserId,input.accountBinding,input.generation]);
  if(!imported.rows.length)return null;
  for(const key of [`crm-mail-project:${current.project_hash}`,`crm-mail-user:${current.user_hash}`].sort())await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  const sums=(await context.db.query<{project:string;user:string}>(`SELECT COALESCE(sum(units) FILTER(WHERE project_hash=$1),0)::text AS project,COALESCE(sum(units) FILTER(WHERE user_hash=$2),0)::text AS "user" FROM crm_mail_import_read_reservations WHERE reserved_at>clock_timestamp()-interval '60 seconds' AND (project_hash=$1 OR user_hash=$2)`,[current.project_hash,current.user_hash])).rows[0]!;
  const units=current[`${input.method}_units`];
  if(typeof units!=='number'||BigInt(sums.project)+BigInt(units)>BigInt(current.project_limit_units-current.project_headroom_units)||BigInt(sums.user)+BigInt(units)>BigInt(current.user_limit_units-current.user_headroom_units))return null;
  const reservation=(await context.db.query<{id:string}>(`INSERT INTO crm_mail_import_read_reservations(workspace_id,import_id,project_hash,user_hash,allocation_revision,method,units) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[context.scope.workspaceId,input.importId,current.project_hash,current.user_hash,current.revision,input.method,units])).rows[0]!;
  return {reservationId:reservation.id,units};
 });
}
export async function observeBackfillRead(context:RepositoryContext,reservationId:string){
 await context.db.query("UPDATE crm_mail_import_read_reservations SET state='observed',observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state='unknown'",[context.scope.workspaceId,reservationId]);
}
