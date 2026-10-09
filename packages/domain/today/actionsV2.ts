import {isDeepStrictEqual} from 'node:util';
import type {TodayActionV2,TodayActionsV2Response,TodayTargetV2} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {readCrmCommitmentActionProofs} from '../crm/commitments.ts';
import {readTodayActions} from './actions.ts';

function calendarDate(at:string,zone:string){
 const parts=new Intl.DateTimeFormat('en',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
 return ['year','month','day'].map(kind=>parts.find(part=>part.type===kind)!.value).join('-');
}
function rank(action:TodayActionV2){return action.kind==='reply'?0:action.kind==='promise'||action.reason==='commitment_projection_failed'?1:action.kind==='call'?2:3;}
function dateKey(action:TodayActionV2){return action.kind==='promise'?action.due===null?'':action.due.kind==='date'?action.due.date:action.due.at:action.dueAt;}

/** Additive current action projection; V1 and its notifications retain their wire shape. */
export async function readTodayActionsV2(context:RepositoryContext,input:{now:string}):Promise<TodayActionsV2Response|null>{
 if(!await activeIdentityActor(context))return null;
 const legacy=await readTodayActions(context,input);
 const promises=await readCrmCommitmentActionProofs(context);
 if(promises===null)return null;
 const replyMessageIds=legacy.actions.flatMap(action=>action.target.kind==='reply'?[action.target.messageId]:[]);
 const actions:TodayActionV2[]=[];
 for(const action of legacy.actions){
  if(action.kind==='problem'&&action.target.kind==='settings'&&action.reason==='mailbox_disconnected'){
   const obstructs=(await context.db.query('SELECT 1 FROM mail_messages WHERE workspace_id=$1 AND mailbox_id=$2 AND id=ANY($3::uuid[]) LIMIT 1',[context.scope.workspaceId,action.target.mailboxId,replyMessageIds])).rows.length>0;
   if(!obstructs)continue;
  }
  actions.push(action);
 }
 for(const blocker of promises.blockers){
  actions.push({actionId:`crm-promise-blocker:${blocker.target.review.commitmentId}:${blocker.target.review.revision}`,kind:'problem',subject:blocker.subject,reason:'commitment_projection_failed',dueAt:blocker.observedAt,state:'open',target:blocker.target});
 }
 for(const promise of promises.items){
  const due=promise.due;if(due===null)continue;
  const overdue=due.kind==='instant'?Date.parse(input.now)>=Date.parse(due.at):calendarDate(input.now,due.zone)>due.date;
  actions.push({actionId:`crm-promise:${promise.target.taskId}:${promise.target.expectedVersion}`,kind:'promise',subject:promise.subject,reason:'dated_promise',due,state:overdue?'overdue':'open',target:promise.target});
 }
 actions.sort((a,b)=>rank(a)-rank(b)||dateKey(a).localeCompare(dateKey(b))||a.actionId.localeCompare(b.actionId));
 if(!await activeIdentityActor(context))return null;
 return {version:2,workspaceId:context.scope.workspaceId,businessTimeZone:legacy.businessTimeZone,asOf:input.now,actions,promiseCoverage:promises.coverage};
}
/** Opening verifies the current receipt; only the separate Complete command changes work. */
export async function openTodayActionV2(context:RepositoryContext,input:{actionId:string;target:TodayTargetV2;now:string}){
 const projection=await readTodayActionsV2(context,{now:input.now});if(projection===null)return null;
 const current=projection.actions.find(action=>action.actionId===input.actionId);
 return {version:2 as const,target:current!==undefined&&isDeepStrictEqual(current.target,input.target)?current.target:null};
}
