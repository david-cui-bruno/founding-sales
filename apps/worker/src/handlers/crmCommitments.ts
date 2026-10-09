import {z} from 'zod';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {projectCrmCommitment} from '@fss/domain/crm/commitments.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
const payload=z.strictObject({commitmentId:z.uuid(),revision:z.number().int().positive()});
export function crmCommitmentJobHandler():JobHandler{return {kind:'crm.commitments_project',protection:'outbound_fence',maxAttempts:3,leaseSeconds:120,handle:async input=>{
 const parsed=payload.safeParse(input.job.payload);if(!parsed.success||input.scope.actor.kind!=='system'||input.scope.actor.component!=='worker')return;
 const owner=(await input.session.query<{owner_user_id:string;role:'admin'|'salesperson';status:string}>('SELECT r.owner_user_id,m.role,m.status FROM crm_commitment_reviews r JOIN workspace_memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id WHERE r.workspace_id=$1 AND r.id=$2',[input.scope.workspaceId,parsed.data.commitmentId])).rows[0];if(owner?.status!=='active')return;
 const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:owner.owner_user_id,role:owner.role}),input.session);
 await withTransaction(input.session,()=>projectCrmCommitment(context,parsed.data,async()=>(await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1,{jobId:input.job.id,fencingToken:String(input.job.fencingToken)}));
}};}
