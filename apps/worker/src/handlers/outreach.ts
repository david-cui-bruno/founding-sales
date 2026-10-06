import {reconcileEmailAttribution} from '@fss/domain/sourcing/attribution.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readReplyRequest} from '@fss/domain/outreach/replyRequests.ts';
import {prepareRoutineReply} from '@fss/domain/outreach/replyDelivery.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {readRoutineSource,requestRoutineReply} from '@fss/domain/outreach/replyRequests.ts';
import {runRoutineReply,expireRoutineReplies,tryLockRoutineWorkspace,type RoutineReplyPort} from '@fss/domain/outreach/replyRun.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
export function outreachReplyHandler(port:RoutineReplyPort|null):JobHandler{return {kind:'outreach.reply',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,handle:async input=>{
 const id=input.job.payload['requestId'];if(typeof id!=='string')return;
 const ctx=repositoryContext(input.scope,input.session);
 await runRoutineReply(ctx,{requestId:id},port);
 await withTransaction(input.session,async()=>{const r=await readReplyRequest(ctx,id);if(r?.state==='ready')await prepareRoutineReply(ctx,{requestId:id,expectedRevision:r.revision});});
}};}
/** Runs the expiry pass even when posting/reply automation is disabled. */
export function outreachReplySource():DueWorkSource{return {name:'outreach-replies',find:async(session,at)=>{
 const workspaces=(await session.query<{id:string}>(`SELECT w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM outbound_messages f WHERE f.workspace_id=w.id AND f.state='sent' AND NOT EXISTS(SELECT 1 FROM sourcing_interactions i WHERE i.workspace_id=f.workspace_id AND i.kind='email' AND i.subject_id=f.id)) OR EXISTS(SELECT 1 FROM mail_messages m JOIN mail_message_matches x ON x.workspace_id=m.workspace_id AND x.mail_message_id=m.id WHERE m.workspace_id=w.id AND m.direction='incoming' AND NOT x.ambiguous AND NOT EXISTS(SELECT 1 FROM sourcing_interactions i WHERE i.workspace_id=m.workspace_id AND i.kind='email' AND i.subject_id=m.id) AND (EXISTS(SELECT 1 FROM mail_message_classifications c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.layer='deterministic' AND c.class='human') OR EXISTS(SELECT 1 FROM mail_reply_confirmations c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id))) OR EXISTS(SELECT 1 FROM outreach_settings s WHERE s.workspace_id=w.id AND s.routine_replies_enabled) OR EXISTS(SELECT 1 FROM outreach_reply_requests r WHERE r.workspace_id=w.id AND r.state IN ('queued','calling') AND r.deadline_at<=$1) ORDER BY w.id LIMIT 25`,[at])).rows;
 const jobs:JobSpecification[]=[];
 for(const workspace of workspaces){
  const ctx=repositoryContext(workspaceScope(workspace.id,{kind:'system',component:'scheduler'}),session);
  if(!await tryLockRoutineWorkspace(ctx))continue;
  await expireRoutineReplies(ctx,at);
  await reconcileEmailAttribution(ctx);
  const enabled=(await session.query<{routine_replies_enabled:boolean}>('SELECT routine_replies_enabled FROM outreach_settings WHERE workspace_id=$1',[workspace.id])).rows[0]?.routine_replies_enabled;
  if(!enabled)continue;
  const incoming=(await session.query<{plan_id:string;message_id:string}>(`SELECT p.id AS plan_id,m.id AS message_id FROM outreach_plans p JOIN mail_message_matches x ON x.workspace_id=p.workspace_id AND x.outreach_plan_id=p.id JOIN mail_messages m ON m.workspace_id=x.workspace_id AND m.id=x.mail_message_id WHERE p.workspace_id=$1 AND p.state IN ('reply_pending','booked') AND m.direction='incoming' AND NOT m.metadata_only AND NOT x.ambiguous AND m.internal_date>$2::timestamptz-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM outreach_reply_requests r WHERE r.workspace_id=m.workspace_id AND r.original_message_id=m.id) ORDER BY m.internal_date DESC,m.id LIMIT 25`,[workspace.id,at])).rows;
  for(const incomingMessage of incoming){const input={planId:incomingMessage.plan_id,messageId:incomingMessage.message_id};const source=await readRoutineSource(ctx,input);if(source.ok)await requestRoutineReply(ctx,{...input,threadRevision:source.value.hash});}
  const pending=(await session.query<{id:string;paid_attempts:number}>(`SELECT r.id,r.paid_attempts FROM outreach_reply_requests r WHERE r.workspace_id=$1 AND ((r.state='queued' AND r.deadline_at>$2) OR (r.state='ready' AND r.created_at>$2::timestamptz-interval '48 hours' AND NOT EXISTS(SELECT 1 FROM outreach_reply_deliveries d WHERE d.workspace_id=r.workspace_id AND d.request_id=r.id))) ORDER BY r.created_at,r.id LIMIT 25`,[workspace.id,at])).rows;
  for(const row of pending)jobs.push({workspaceId:workspace.id,kind:'outreach.reply',idempotencyKey:`outreach-reply:${row.id}:${row.paid_attempts}:${at.slice(0,16)}`,payload:{requestId:row.id},maxAttempts:1});
 }
 return jobs;
}};}
