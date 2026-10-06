import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForDispatch} from '../policy/sendGate.ts';
import {localDate} from '../src/rules/localClock.ts';
import {nextProspectingTouch,type OutreachCadence} from './cadence.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
interface Plan {[column: string]: unknown;id:string;firm_id:string;owner_user_id:string;state:string;revision:number;cadence:OutreachCadence|null;expires_at:Date|null;}
/** Shared with call ticket and Gmail claim transactions. No provider call occurs here. */
export async function claimProspectingTouch(ctx:RepositoryContext,input:{planId:string;expectedRevision:number;actionId:string;channel:'phone'|'email';at:string;expectedOrdinal?:number}):Promise<Result<{reservationId:string;localDate:string}>> {
 if(!input.actionId||input.actionId.length>200||!Number.isFinite(Date.parse(input.at)))return {ok:false,reason:'invalid_input'};
 await lockSendGateForDispatch(ctx);
 const initial=(await ctx.db.query<Plan>('SELECT id,firm_id,owner_user_id,state,revision,cadence,expires_at FROM outreach_plans WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,input.planId])).rows[0];
 if(!initial)return {ok:false,reason:'plan_unknown'};
 const firm=(await ctx.db.query<{status:string;assigned_user_id:string|null}>('SELECT status,assigned_user_id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,initial.firm_id])).rows[0];
 if(!firm||firm.status!=='active'||firm.assigned_user_id!==initial.owner_user_id)return {ok:false,reason:'owner_changed'};
 const actor=ctx.scope.actor;
 if(actor.kind==='user'&&actor.role!=='admin'&&actor.userId!==initial.owner_user_id)return {ok:false,reason:'not_assigned'};
 const plan=(await ctx.db.query<Plan>('SELECT id,firm_id,owner_user_id,state,revision,cadence,expires_at FROM outreach_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.planId])).rows[0]!;
 if(plan.state!=='active'||plan.revision!==input.expectedRevision)return {ok:false,reason:'plan_changed'};
 if(!plan.cadence||!plan.expires_at||Date.parse(input.at)>plan.expires_at.getTime())return {ok:false,reason:'plan_expired'};
 const date=localDate(input.at,plan.cadence.timeZone);
 await releaseAbandonedTouches(ctx,plan.firm_id,input.at);
 const replay=(await ctx.db.query<{id:string;plan_id:string;state:string;local_date:string}>("SELECT id,plan_id,state,local_date::text FROM outreach_touch_reservations WHERE workspace_id=$1 AND channel=$2 AND action_id=$3",[ctx.scope.workspaceId,input.channel,input.actionId])).rows[0];
 if(replay&&replay.state!=='released')return replay.plan_id===plan.id&&replay.state!=='released'&&replay.local_date===date?{ok:true,value:{reservationId:replay.id,localDate:date}}:{ok:false,reason:'action_already_used'};
 // Original firm IDs remain on dispatch history after a merge. Include every merged
 // ancestor when checking capacity; a merge cannot mint a second daily/lifetime budget.
 // Expired, never-consumed call tickets prove no handoff happened. The firm lock
 // is also held by ticket consumption, so expiry cannot race a successful consume.

 const rows=(await ctx.db.query<{plan_id:string;ordinal:number;channel:string;state:string;local_date:string;claimed_at:Date}>(`WITH RECURSIVE family AS (
 SELECT id FROM firms WHERE workspace_id=$1 AND id=$2
 UNION SELECT f.id FROM firms f JOIN family parent ON f.merged_into_firm_id=parent.id WHERE f.workspace_id=$1)
 SELECT r.plan_id,r.ordinal,r.channel,r.state,r.local_date::text,r.claimed_at FROM outreach_touch_reservations r JOIN family f ON f.id=r.firm_id
 WHERE r.workspace_id=$1 AND r.state<>'released' ORDER BY r.claimed_at,r.id`,[ctx.scope.workspaceId,plan.firm_id])).rows;
 if(rows.some(r=>r.local_date===date))return {ok:false,reason:'firm_touched_today'};
 if(rows.some(r=>r.state==='reserved'||r.state==='unknown'))return {ok:false,reason:'touch_in_flight'};
 const limit=input.channel==='email'?(plan.cadence.lane==='email_first'?5:4):(plan.cadence.lane==='call_first'?4:0);
 if(rows.filter(r=>r.channel===input.channel).length>=limit)return {ok:false,reason:'lifetime_limit'};
 const own=rows.filter(r=>r.plan_id===plan.id);
 const next=nextProspectingTouch({plan:plan.cadence,at:input.at,completedOrdinals:own.map(r=>r.ordinal),lastTouchAt:own.at(-1)?.claimed_at.toISOString()??null});
 if(!next||next.touch.channel!==input.channel||(input.expectedOrdinal!==undefined&&next.touch.ordinal!==input.expectedOrdinal))return {ok:false,reason:'touch_not_due'};
 const inserted=(await ctx.db.query<{id:string}>(`INSERT INTO outreach_touch_reservations(workspace_id,plan_id,firm_id,action_id,channel,ordinal,local_date,claimed_at,skipped_ordinals)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(workspace_id,channel,action_id) DO UPDATE SET ordinal=EXCLUDED.ordinal,skipped_ordinals=EXCLUDED.skipped_ordinals,local_date=EXCLUDED.local_date,state='reserved',claimed_at=EXCLUDED.claimed_at,settled_at=NULL WHERE outreach_touch_reservations.state='released' AND outreach_touch_reservations.plan_id=EXCLUDED.plan_id RETURNING id`,[ctx.scope.workspaceId,plan.id,plan.firm_id,input.actionId,input.channel,next.touch.ordinal,date,input.at,next.skippedOrdinals])).rows[0]!;
 if(!inserted)return {ok:false,reason:'action_already_used'};
 return {ok:true,value:{reservationId:inserted.id,localDate:date}};
}
/** Only provider/ticket reconciliation may supply a proven non-dispatch result. */
export async function settleProspectingTouch(ctx:RepositoryContext,input:{reservationId:string;outcome:'accepted'|'not_dispatched'|'unknown'}):Promise<void>{
 const state=input.outcome==='not_dispatched'?'released':input.outcome;
 await ctx.db.query("UPDATE outreach_touch_reservations SET state=$3,settled_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND state IN ('reserved','unknown')",[ctx.scope.workspaceId,input.reservationId,state]);
}

export async function reserveOutreachEmail(ctx:RepositoryContext,executionId:string,at:string):Promise<Result<{reservationId:string|null}>>{
 const row=(await ctx.db.query<{id:string;revision:number;cadence:OutreachCadence;channel_ordinal:number}>(`SELECT p.id,p.revision,p.cadence,(SELECT count(*)::int FROM sequence_steps s WHERE s.workspace_id=e.workspace_id AND s.sequence_version_id=e.sequence_version_id AND s.channel='email' AND s.ordinal<=x.ordinal) AS channel_ordinal FROM step_executions x JOIN sequence_enrollments e ON e.workspace_id=x.workspace_id AND e.id=x.enrollment_id JOIN outreach_plans p ON p.workspace_id=e.workspace_id AND p.id=e.outreach_plan_id WHERE x.workspace_id=$1 AND x.id=$2 AND e.origin_kind='prospecting'`,[ctx.scope.workspaceId,executionId])).rows[0];
 if(!row)return {ok:true,value:{reservationId:null}};
 const touch=row.cadence?.touches.find(t=>t.channel==='email'&&t.channelOrdinal===row.channel_ordinal);
 if(!touch)return {ok:false,reason:'touch_not_due'};
 return await claimProspectingTouch(ctx,{planId:row.id,expectedRevision:row.revision,actionId:executionId,channel:'email',at,expectedOrdinal:touch.ordinal});
}
export async function settleOutreachAction(ctx:RepositoryContext,actionId:string|null,channel:'phone'|'email',outcome:'accepted'|'not_dispatched'|'unknown'):Promise<void>{
 if(actionId===null)return;
 const row=(await ctx.db.query<{id:string}>('SELECT id FROM outreach_touch_reservations WHERE workspace_id=$1 AND action_id=$2 AND channel=$3',[ctx.scope.workspaceId,actionId,channel])).rows[0];
 if(row)await settleProspectingTouch(ctx,{reservationId:row.id,outcome});
}

/** Explicit confirmed callbacks are follow-up work, not another cold attempt. */
export async function reserveOutreachCall(ctx:RepositoryContext,input:{firmId:string;contactId:string|null;ticketId:string;at:string}):Promise<Result<{reservationId:string|null}>>{
 const callback=(await ctx.db.query(`SELECT c.id FROM callbacks c WHERE c.workspace_id=$1 AND c.firm_id=$2 AND c.contact_id IS NOT DISTINCT FROM $3::uuid AND c.status='open' AND c.due_at<=$4::timestamptz AND (
 EXISTS(SELECT 1 FROM call_logs l WHERE l.workspace_id=c.workspace_id AND l.id=c.call_log_id AND l.outcome='callback_requested')
 OR EXISTS(SELECT 1 FROM mail_reply_confirmations r WHERE r.workspace_id=c.workspace_id AND r.callback_id=c.id AND r.disposition='follow_up_later')) LIMIT 1`,[ctx.scope.workspaceId,input.firmId,input.contactId,input.at])).rows[0];
 if(callback)return {ok:true,value:{reservationId:null}};
 const row=(await ctx.db.query<{id:string;revision:number;contact_id:string}>("SELECT id,revision,contact_id FROM outreach_plans WHERE workspace_id=$1 AND firm_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",[ctx.scope.workspaceId,input.firmId])).rows[0];
 if(!row)return {ok:true,value:{reservationId:null}};
 if(row.contact_id!==input.contactId)return {ok:false,reason:'outreach_contact_mismatch'};
 return await claimProspectingTouch(ctx,{planId:row.id,expectedRevision:row.revision,actionId:input.ticketId,channel:'phone',at:input.at});
}

/** Same gate and firm lock as ticket consumption: expiry is proof only before consumption. */
export async function releaseAbandonedTouches(ctx:RepositoryContext,firmId:string,at:string):Promise<void>{
 await lockSendGateForDispatch(ctx);
 await ctx.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,firmId]);
 await ctx.db.query(`UPDATE outreach_touch_reservations r SET state='released',settled_at=clock_timestamp()
 WHERE r.workspace_id=$1 AND r.firm_id=$2 AND r.channel='phone' AND r.state='reserved'
 AND EXISTS(SELECT 1 FROM dial_tickets t WHERE t.workspace_id=r.workspace_id AND t.id::text=r.action_id AND t.consumed_at IS NULL AND t.expires_at<=$3::timestamptz)`,[ctx.scope.workspaceId,firmId,at]);
 // A prepared/held fence with no dispatch marker proves the provider was never
 // called. Reclaim only past-day capacity; accepted/unknown work stays reserved.
 await ctx.db.query(`UPDATE outreach_touch_reservations r SET state='released',settled_at=clock_timestamp()
 FROM outreach_plans p,outbound_messages f WHERE r.workspace_id=$1 AND r.firm_id=$2 AND r.channel='email' AND r.state='reserved'
 AND p.workspace_id=r.workspace_id AND p.id=r.plan_id
 AND r.local_date<($3::timestamptz AT TIME ZONE (p.cadence->>'timeZone'))::date
 AND f.workspace_id=r.workspace_id AND f.step_execution_id::text=r.action_id
 AND f.state IN ('prepared','held') AND f.dispatch_started_at IS NULL AND f.attempt_token IS NULL`,[ctx.scope.workspaceId,firmId,at]);

}
