import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {FollowUpPermissionRow,FollowUpSubject} from '../sequences/followUpPermissions.ts';
import {readFence} from '../outbound/fence.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
interface Delivery {[key:string]:unknown;request_id:string;thread_id:string;reply_to:string;reference_ids:string[]}
/** Historical permissions remain readable, but never authorize a new incoming send. */
export async function verifyRoutinePermission(_ctx:RepositoryContext,_permission:FollowUpPermissionRow,_subject:FollowUpSubject):Promise<string|null>{
 return 'automatic_incoming_retired';
}
export async function routineDraftForExecution(ctx:RepositoryContext,executionId:string):Promise<{ok:false;reason:string}|null>{
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND execution_id=$2',[ctx.scope.workspaceId,executionId])).rows[0];
 return d?{ok:false,reason:'automatic_incoming_retired'}:null;
}
export async function verifyRoutineReplyFence(ctx:RepositoryContext,input:{fenceId:string;at:string}):Promise<Result<{requestId:string|null}>>{
 const f=await readFence(ctx,input.fenceId);if(!f?.stepExecutionId)return {ok:true,value:{requestId:null}};
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND execution_id=$2',[ctx.scope.workspaceId,f.stepExecutionId])).rows[0];
 return d?{ok:false,reason:'automatic_incoming_retired'}:{ok:true,value:{requestId:null}};
}
/** Attempted sends reconcile using frozen provider identities, not current source rendering. */
export async function routineReplyThreading(ctx:RepositoryContext,fenceId:string):Promise<{threadId:string;inReplyTo:string;references:readonly string[]}|null>{
 const d=(await ctx.db.query<Delivery>('SELECT * FROM outreach_reply_deliveries WHERE workspace_id=$1 AND fence_id=$2',[ctx.scope.workspaceId,fenceId])).rows[0];
 return d?{threadId:d.thread_id,inReplyTo:d.reply_to,references:d.reference_ids}:null;
}
export async function recordRoutineDelivery(ctx:RepositoryContext,fenceId:string):Promise<void>{
 await ctx.db.query(`UPDATE outreach_reply_requests r SET state='delivered',revision=revision+1,updated_at=now() FROM outreach_reply_deliveries d JOIN outbound_messages f ON f.workspace_id=d.workspace_id AND f.id=d.fence_id WHERE d.workspace_id=$1 AND d.fence_id=$2 AND f.state='sent' AND r.workspace_id=d.workspace_id AND r.id=d.request_id AND r.state='ready'`,[ctx.scope.workspaceId,fenceId]);
}
