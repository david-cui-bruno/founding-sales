import {z} from 'zod';
import {targetingProposalSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {recordCrmAuditEvent} from '@fss/domain/crm/audit.ts';
import {saveTargetingProposal,applyTargetingProposal,readTargetingPolicy} from '@fss/domain/sourcing/targetingProposals.ts';
import type {AdminInvocation,AdminOutcome} from './admin.ts';
const optionsSchema=z.strictObject({'--report':z.string().optional(),'--workspace-id':z.uuid(),'--owner-user-id':z.uuid(),'--proposal-json-base64':z.string().min(4).max(65536)});
class ConfigureRefusal extends Error{constructor(readonly reason:string){super(reason);}}
/** Audited adapter only: normal targeting CAS, review and storage owners remain authoritative. */
export async function targetingConfigureCommand(input:Pick<AdminInvocation,'session'|'options'|'launch'>):Promise<AdminOutcome>{
 const options=optionsSchema.safeParse(input.options);
 if(!options.success)return {ok:false,reason:'invalid_options',detail:'Supply workspace, active administrator and bounded proposal JSON as canonical Base64.'};
 const o=options.data,encoded=o['--proposal-json-base64'];let proposal:z.infer<typeof targetingProposalSchema>;
 try{
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length>49152||bytes.toString('base64')!==encoded)throw Error('invalid encoding');
  proposal=targetingProposalSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
 }catch{return {ok:false,reason:'invalid_proposal',detail:'Supply a schema-valid proposal in canonical Base64 within49,152 decoded bytes.'};}
 const launch=input.launch;
 if(!launch?.launchedBy?.startsWith('arn:aws:')||!launch.taskArn?.startsWith('arn:aws:ecs:'))return {ok:false,reason:'launcher_unknown',detail:'Run through the audited ECS operations task.'};
 try{return await withTransaction(input.session,async()=>{
  const w=o['--workspace-id'],owner=o['--owner-user-id'],ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:owner,role:'admin'}),input.session);
  const member=()=>input.session.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[w,owner]);
  if(!(await member()).rows.length)throw new ConfigureRefusal('owner_inactive');
  const saved=await saveTargetingProposal(ctx,proposal);if(!saved.ok)throw new ConfigureRefusal(saved.reason);
  const applied=await applyTargetingProposal(ctx,{id:saved.value.id,expectedRevision:saved.value.revision});if(!applied.ok)throw new ConfigureRefusal(applied.reason);
  const queryCount=(await readTargetingPolicy(ctx)).queries.length;
  await recordCrmAuditEvent(ctx,{action:'sourcing.targeting_configured',subjectKind:'workspace',subjectId:w,detail:{proposalId:saved.value.id,policyVersion:applied.value.policyVersion,queryCount,ownerUserId:owner,launchedBy:launch.launchedBy,taskArn:launch.taskArn}});
  if(!(await member()).rows.length)throw new ConfigureRefusal('owner_inactive');
  return {ok:true,value:{proposalId:saved.value.id,policyVersion:applied.value.policyVersion,queryCount}};
 });}catch(error){if(error instanceof ConfigureRefusal)return {ok:false,reason:error.reason,detail:'The targeting operation was refused and rolled back.'};throw error;}
}
