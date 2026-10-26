import {callSessionCreatedSchema,callingExecutionReceiptSchema,type CallingExecutionReceipt,type CallingExecutionReceiptInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {requireCallingAuthority,type CallingAuthority} from '../calling/followUpDraftAccess.ts';

/** Read inside the caller's transaction. Firm -> session -> current principal matches
 * consumption's row order. Never consumes a ticket, releases money or calls a provider. */
export async function readCallingExecutionReceipt(ctx:RepositoryContext,input:CallingExecutionReceiptInput,deviceId:string,authority:CallingAuthority):Promise<CallingExecutionReceipt>{
 const actor=ctx.scope.actor;
 if(actor.kind!=='user')return {state:'unknown'};
 const receipt=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r
  JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
  WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4
    AND r.command_kind='create_call_session' AND r.payload_hash=$5`,[ctx.scope.workspaceId,input.commandId,deviceId,actor.userId,input.payloadSHA256])).rows[0];
 const firm=(await ctx.db.query<{assigned_user_id:string|null;status:string}>(
  'SELECT assigned_user_id,status FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.scope.workspaceId,input.firmId])).rows[0];
 let answer:CallingExecutionReceipt={state:'unknown'};
 if(firm?.status==='active'&&firm.assigned_user_id===actor.userId&&receipt){
  if(receipt.result_status==='refused')answer={state:'refused'};
  else if(receipt.result_status==='accepted'){
   const created=callSessionCreatedSchema.safeParse(receipt.result);
   if(created.success){
    const session=(await ctx.db.query<{id:string;status:string;expires_at:Date;consumed_at:Date|null}>(`SELECT s.id,s.status,s.expires_at,s.consumed_at FROM call_sessions s
     JOIN dial_tickets t ON t.workspace_id=s.workspace_id AND t.id=s.ticket_id
     WHERE s.workspace_id=$1 AND s.id=$2 AND s.firm_id=$3 AND s.actor_user_id=$4
       AND t.device_id=$5 AND t.command_id=$6 AND t.firm_id=$3 FOR UPDATE OF s`,
    [ctx.scope.workspaceId,created.data.sessionId,input.firmId,actor.userId,deviceId,input.commandId])).rows[0];
    if(session&&session.expires_at.toISOString()===created.data.expiresAt){
     // A separate statement runs AFTER acquiring the row lock, including any wait.
     const clock=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]?.at;
     answer=callingExecutionReceiptSchema.parse({state:'accepted',firmId:input.firmId,sessionId:session.id,expiresAt:created.data.expiresAt,
      status:clock&&session.consumed_at===null&&clock.getTime()>=session.expires_at.getTime()?'expired_unconsumed':session.status,canReconnect:false});
    }
   }
  }
 }
 await requireCallingAuthority(ctx,authority);
 return answer;
}
