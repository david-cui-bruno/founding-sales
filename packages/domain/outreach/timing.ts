import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {ResolvedDueInstant} from '../src/rules/businessDays.ts';
import {addCalendarDays,localDate,localInstant,localParts,weekdayOfDate} from '../src/rules/localClock.ts';
import {nextProspectingTouch,type OutreachCadence} from './cadence.ts';
export function outreachStepDue(plan:OutreachCadence,input:{channel:string;channelOrdinal:number;lastTouch:{ordinal:number;at:string}|null}):ResolvedDueInstant|null {
 const channel=input.channel==='call_task'?'phone':input.channel;
 const touch=plan.touches.find(t=>t.channel===channel&&t.channelOrdinal===input.channelOrdinal);
 if(!touch)return null;
 let dueAt=touch.dueAt;
 const prior=input.lastTouch===null?undefined:plan.touches.find(t=>t.ordinal===input.lastTouch!.ordinal);
 if(prior&&input.lastTouch&&prior.ordinal<touch.ordinal){
  const gap=Math.max(1,Math.round((Date.parse(`${touch.localDate}T00:00:00Z`)-Date.parse(`${prior.localDate}T00:00:00Z`))/86400000));
  let date=addCalendarDays(localDate(input.lastTouch.at,plan.timeZone),gap);
  while([0,6].includes(weekdayOfDate(date)))date=addCalendarDays(date,1);
  const clock=localParts(touch.dueAt,plan.timeZone);
  const floor=localInstant(date,{hour:clock.hour,minute:clock.minute},plan.timeZone);
  if(Date.parse(floor)>Date.parse(dueAt))dueAt=floor;
 }
 if(Date.parse(dueAt)>Date.parse(plan.expiresAt))return null;
 return {dueAt,sourceZone:plan.timeZone,localDate:localDate(dueAt,plan.timeZone),ruleVersion:plan.version};
}
export async function readOutreachCadence(ctx:RepositoryContext,planId:string):Promise<OutreachCadence|null>{
 return (await ctx.db.query<{cadence:OutreachCadence|null}>('SELECT cadence FROM outreach_plans WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,planId])).rows[0]?.cadence??null;
}
export async function lastOutreachTouch(ctx:RepositoryContext,planId:string):Promise<{ordinal:number;at:string}|null>{
 const row=(await ctx.db.query<{ordinal:number;claimed_at:Date}>("SELECT ordinal,claimed_at FROM outreach_touch_reservations WHERE workspace_id=$1 AND plan_id=$2 AND state IN ('accepted','unknown') ORDER BY claimed_at DESC,id DESC LIMIT 1",[ctx.scope.workspaceId,planId])).rows[0];
 return row?{ordinal:row.ordinal,at:row.claimed_at.toISOString()}:null;
}
export async function outreachExecutionTiming(ctx:RepositoryContext,input:{planId:string;channel:string;channelOrdinal:number;executionId:string;at:string}):Promise<{kind:'proceed'}|{kind:'skip'}|{kind:'hold'}|{kind:'wait';dueAt:string}>{
 const plan=await readOutreachCadence(ctx,input.planId);
 if(!plan||Date.parse(input.at)>Date.parse(plan.expiresAt))return {kind:'hold'};
 const touch=plan.touches.find(t=>t.channel===(input.channel==='call_task'?'phone':input.channel)&&t.channelOrdinal===input.channelOrdinal);
 if(!touch)return {kind:'hold'};
 const rows=(await ctx.db.query<{ordinal:number;action_id:string;state:string;claimed_at:Date}>("SELECT ordinal,action_id,state,claimed_at FROM outreach_touch_reservations WHERE workspace_id=$1 AND plan_id=$2 AND state<>'released' ORDER BY claimed_at,id",[ctx.scope.workspaceId,input.planId])).rows;
 if(rows.some(r=>(r.state==='reserved'||r.state==='unknown')&&r.action_id!==input.executionId))return {kind:'hold'};
 if(rows.some(r=>r.action_id===input.executionId))return {kind:'proceed'};
 const last=rows.at(-1);
 if(rows.some(r=>r.ordinal===touch.ordinal&&r.state==='accepted'))return {kind:'skip'};
 const next=nextProspectingTouch({plan,at:input.at,completedOrdinals:rows.map(r=>r.ordinal),lastTouchAt:last?.claimed_at.toISOString()??null});
 if(next&&next.touch.ordinal>touch.ordinal)return {kind:'skip'};
 const due=outreachStepDue(plan,{channel:input.channel,channelOrdinal:input.channelOrdinal,lastTouch:last?{ordinal:last.ordinal,at:last.claimed_at.toISOString()}:null});
 if(!due)return {kind:'hold'};
 if(Date.parse(due.dueAt)>Date.parse(input.at))return {kind:'wait',dueAt:due.dueAt};
 return next?.touch.ordinal===touch.ordinal?{kind:'proceed'}:{kind:'hold'};
}
