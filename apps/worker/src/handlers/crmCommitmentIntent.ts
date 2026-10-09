import {z} from 'zod';
import {crmSourceLookupSchema} from '@fss/contracts';
import {admitVerifiedCommitmentIntent} from '@fss/domain/crm/commitments.ts';
import {createNativeCrmMailEvidence} from '@fss/domain/crm/nativeMailEvidence.ts';
import type {CrmMailEvidencePort} from '@fss/domain/crm/mailEvidence.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
const payload=z.strictObject({generationId:z.uuid(),claimId:z.uuid(),source:crmSourceLookupSchema,contextHash:z.string().regex(/^[a-f0-9]{64}$/u)});
export function crmCommitmentIntentJobHandler(mail:CrmMailEvidencePort=createNativeCrmMailEvidence()):JobHandler{return {kind:'crm.commitments_intent',protection:'outbound_fence',maxAttempts:3,leaseSeconds:120,handle:async input=>{
 const parsed=payload.safeParse(input.job.payload);if(!parsed.success||parsed.data.source.kind!=='mail'||parsed.data.source.workspaceId!==input.scope.workspaceId||input.scope.actor.kind!=='system'||input.scope.actor.component!=='worker')return;
 const owner=(await input.session.query<{owner_user_id:string;role:'admin'|'salesperson';status:string}>(`SELECT s.owner_user_id,m.role,m.status FROM crm_mail_sources s JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id WHERE s.workspace_id=$1 AND s.source_id=$2 AND s.source_revision=$3 AND s.content_hash=$4 AND s.availability='available'`,[input.scope.workspaceId,parsed.data.source.sourceId,parsed.data.source.revision,parsed.data.source.contentHash])).rows[0];if(owner?.status!=='active')return;
 const context=repositoryContext(workspaceScope(input.scope.workspaceId,{kind:'user',userId:owner.owner_user_id,role:owner.role}),input.session);
 await withTransaction(input.session,()=>admitVerifiedCommitmentIntent(context,parsed.data,async()=>(await input.session.query("SELECT id FROM jobs WHERE workspace_id=$1 AND id=$2 AND state='running' AND lease_owner=$3 AND fencing_token=$4::bigint AND lease_expires_at>clock_timestamp() FOR UPDATE",[input.scope.workspaceId,input.job.id,input.job.leaseOwner,input.job.fencingToken])).rows.length===1,mail));
}};}
