import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
const importPayload=z.strictObject({importId:z.string().uuid()});
/** Absent acquisition configuration is a durable health state, never permission to read Gmail. */
export function crmMailBackfillJobHandler():JobHandler{return {
 kind:'crm.mail_backfill',protection:'outbound_fence',maxAttempts:4,leaseSeconds:120,
 async handle(input){
  const parsed=importPayload.safeParse(input.job.payload);
  if(!parsed.success||input.scope.actor.kind!=='system'||input.scope.actor.component!=='worker'||input.scope.workspaceId!==input.job.workspaceId)return;
  await withTransaction(input.session,async()=>{
   const head=await input.session.query('SELECT id FROM crm_mail_imports WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[input.scope.workspaceId,parsed.data.importId]);
   if(!head.rows.length)return;
   const leased=await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken]);
   if(!leased.rows.length)return;
   await input.session.query("UPDATE crm_mail_imports SET state='blocked',reason='backfill_configuration_required' WHERE workspace_id=$1 AND id=$2 AND state<>'complete'",[input.scope.workspaceId,parsed.data.importId]);
  });
 },
};}
