import {answerBlocksReadSchema,saveAnswerBlockCommandSchema,answerBlockApprovalCommandSchema} from '@fss/contracts';
import {saveAnswerBlock,approveAnswerBlock,retireAnswerBlock,listAnswerBlocks} from '@fss/domain/outreach/facts.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,runRouteCommand,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';
/** Only existing fact routes. Shared receipt runner and all wire schemas remain unchanged. */
export async function routeOutreachFacts(deps:RouteDeps):Promise<RouteResult>{
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const fence=(ctx:RepositoryContext)=>async():Promise<void>=>{
  const p=deps.principal;
  if(p.role!=='admin'||!(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[p.workspaceId,p.userId])).rows.length)throw new PrivateDraftAuthorityChanged();
  await requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx));
 };
 try{
  let result:RouteResult;
  if(deps.request.path==='/outreach/answer-blocks'){
   const input=answerBlocksReadSchema.safeParse(deps.request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
   result=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context;await fence(ctx)();
    const blocks=await listAnswerBlocks(ctx,input.data.afterId);await fence(ctx)();
    return {status:200,body:{blocks}};
   });
  }else if(deps.request.path==='/outreach/answer-blocks/save'){
   result=await runRouteCommand(deps,saveAnswerBlockCommandSchema,'outreach_answer_save',async(ctx,input)=>{
    const {commandId:_command,clientVersion:_client,...content}=input;
    const saved=await saveAnswerBlock(ctx,content,fence(ctx));return saved.ok?{ok:true as const,value:{id:saved.value.id,version:saved.value.version}}:saved;
   },ctx=>fence(ctx)());
  }else{
   const approve=deps.request.path==='/outreach/answer-blocks/approve';
   result=await runRouteCommand(deps,answerBlockApprovalCommandSchema,approve?'outreach_answer_approve':'outreach_answer_retire',async(ctx,input)=>{
    const saved=await (approve?approveAnswerBlock:retireAnswerBlock)(ctx,input,fence(ctx));return saved.ok?{ok:true as const,value:{id:saved.value.id,version:saved.value.version}}:saved;
   },ctx=>fence(ctx)());
  }
  // Replayed receipts skip work/beforeCommit. They still cannot project under a
  // revoked or changed initiating principal after the receipt read wait.
  if(!await privatePrincipalIsCurrent(deps))return privateAuthorityRefusal();
  return result;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return privateAuthorityRefusal();throw error;}
}
