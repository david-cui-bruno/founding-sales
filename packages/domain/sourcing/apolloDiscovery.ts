import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {apolloAllowed,lockApolloAccount,reserveApolloPage,type ApolloDiscoveryDependencies} from './apolloAllowance.ts';
import {intakeApolloOrganizations} from './apolloIntake.ts';
import type {OrganizationDiscoveryResult} from './discoveryProvider.ts';

/** Owns transactions. Reservations commit before the single external request.
 * Unknown delivery is spent and inspection-only, never retryable or refundable.
 */
export async function runApolloDiscovery(ctx:RepositoryContext,deps:ApolloDiscoveryDependencies):Promise<void>{
 const db=ctx.db as SessionQueryable;
 const attempt=await withTransaction(db,()=>reserveApolloPage(ctx,deps));
 if(!attempt)return;
 let result:OrganizationDiscoveryResult;
 try{result=await deps.provider.discoverOrganizations({region:attempt.region,page:attempt.page,perPage:100});}
 catch{result={ok:false,code:'unavailable'};}
 const answer=result;
 await withTransaction(db,async()=>{
  await lockApolloAccount(db,deps.accountRef);
  const allowance=(await db.query<{enabled:boolean;key_ref:string}>(`SELECT enabled,key_ref FROM sourcing_apollo_allowances WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,[attempt.allowanceId,ctx.scope.workspaceId])).rows[0];
  const row=(await db.query<{state:string}>(`SELECT state FROM sourcing_apollo_attempts WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,[attempt.id,ctx.scope.workspaceId])).rows[0];
  if(!row||row.state!=='reserved')return; // Expired/reconciled observations cannot publish later.
  if(!answer.ok){
   const code=['invalid_query','invalid_response','auth_failed','quota_exhausted','rate_limited','unavailable'].includes(answer.code)?answer.code:'invalid_response';
   await db.query('UPDATE sourcing_apollo_allowances SET halted=true WHERE id=$1',[attempt.allowanceId]);
   await db.query("UPDATE sourcing_apollo_attempts SET state='failed',failure_code=$2,finished_at=clock_timestamp() WHERE id=$1",[attempt.id,code]);
   await recordCrmAuditEvent(ctx,{action:'sourcing.apollo_failed',subjectKind:'sourcing_apollo_attempt',subjectId:attempt.id,detail:{provider:'apollo_free',code,creditReserved:true}});
   return;
  }
  if(!Number.isInteger(answer.returnedCount)||answer.returnedCount<0||answer.returnedCount>100||answer.organizations.length>answer.returnedCount){
   await db.query('UPDATE sourcing_apollo_allowances SET halted=true WHERE id=$1',[attempt.allowanceId]);
   await db.query("UPDATE sourcing_apollo_attempts SET state='failed',failure_code='invalid_response',finished_at=clock_timestamp() WHERE id=$1",[attempt.id]);return;
  }
  const current=(await db.query<{valid:boolean}>(`SELECT cycle_start<=clock_timestamp() AND clock_timestamp()<cycle_end AND verified_at<=clock_timestamp() AND exclusive_attested_at<=clock_timestamp() AS valid FROM sourcing_apollo_allowances WHERE id=$1`,[attempt.allowanceId])).rows[0];
  const publish=allowance?.enabled&&allowance.key_ref===deps.keyRef&&current?.valid&&await apolloAllowed(ctx);
  const counts=publish?await intakeApolloOrganizations(ctx,attempt,answer.organizations):{created:0,deduplicated:0,incomplete:0};
  await db.query("UPDATE sourcing_apollo_attempts SET state='complete',request_id=$2,returned_count=$3,created_count=$4,finished_at=clock_timestamp() WHERE id=$1",[attempt.id,attempt.id,answer.returnedCount,counts.created]);
  await recordCrmAuditEvent(ctx,{action:'sourcing.apollo_completed',subjectKind:'sourcing_apollo_attempt',subjectId:attempt.id,detail:{provider:'apollo_free',creditReserved:true,returned:answer.returnedCount,created:counts.created,deduplicated:counts.deduplicated,incomplete:counts.incomplete,publicationHeld:!publish,firstPartyQualified:0}});
 });
}
