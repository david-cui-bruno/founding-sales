import {reconcileEmailAttribution} from '@fss/domain/sourcing/attribution.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {expireRoutineReplies,tryLockRoutineWorkspace} from '@fss/domain/outreach/replyRun.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
/** Retained expiry and attribution only. Historical settings never create new incoming work. */
export function outreachReplySource():DueWorkSource{return {name:'outreach-replies',find:async(session,at)=>{
 const workspaces=(await session.query<{id:string}>(`SELECT w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM outbound_messages f WHERE f.workspace_id=w.id AND f.state='sent' AND NOT EXISTS(SELECT 1 FROM sourcing_interactions i WHERE i.workspace_id=f.workspace_id AND i.kind='email' AND i.subject_id=f.id)) OR EXISTS(SELECT 1 FROM mail_messages m JOIN mail_message_matches x ON x.workspace_id=m.workspace_id AND x.mail_message_id=m.id WHERE m.workspace_id=w.id AND m.direction='incoming' AND NOT x.ambiguous AND NOT EXISTS(SELECT 1 FROM sourcing_interactions i WHERE i.workspace_id=m.workspace_id AND i.kind='email' AND i.subject_id=m.id) AND (EXISTS(SELECT 1 FROM mail_message_classifications c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id AND c.layer='deterministic' AND c.class='human') OR EXISTS(SELECT 1 FROM mail_reply_confirmations c WHERE c.workspace_id=m.workspace_id AND c.mail_message_id=m.id))) OR EXISTS(SELECT 1 FROM outreach_reply_requests r WHERE r.workspace_id=w.id AND r.state IN ('queued','calling') AND r.deadline_at<=$1) ORDER BY w.id LIMIT 25`,[at])).rows;
 for(const workspace of workspaces){
  const ctx=repositoryContext(workspaceScope(workspace.id,{kind:'system',component:'scheduler'}),session);
  if(!await tryLockRoutineWorkspace(ctx))continue;
  await expireRoutineReplies(ctx,at);
  await reconcileEmailAttribution(ctx);
 }
 return [];
}};}
