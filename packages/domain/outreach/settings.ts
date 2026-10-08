import {readEmailAdmissionControl} from './emailControl.ts';
import {routineSettingsSaveSchema,type OutreachControl,type OutreachSenderStandingResponse,type OutreachSenderStandingV2Response} from '@fss/contracts';
import {readProviderIncidents} from '../outbound/providerIncidents.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {readSequenceVersion} from '../sequences/rows.ts';
import {readTemplateVersion} from '../templates/templates.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {listAnswerBlocks} from './facts.ts';
import {authorizationForMailbox} from './authorization.ts';
import {describeRampStanding,ensureRamp,readRampStanding} from '../outbound/ramp.ts';
import {stopEnrollments} from '../sequences/enrollments.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
export async function campaignKind(ctx:RepositoryContext,id:string):Promise<'reply'|'email_first'|'call_first'|null>{
 const v=await readSequenceVersion(ctx,id);if(!v||v.state!=='published')return null;
 const channels=v.steps.map(s=>s.channel).join(',');
 const kind=channels==='email'?'reply':channels==='email,email,email,email,email'?'email_first':channels==='call_task,email,call_task,email,call_task,email,call_task,email'?'call_first':null;
 if(!kind)return null;
 for(const step of v.steps.filter(s=>s.channel==='email')){const t=step.templateVersionId?await readTemplateVersion(ctx,step.templateVersionId):null;if(!t||!t.approvedAt||t.retiredAt)return null;}
 return kind;
}
export async function readRoutineSettings(ctx:RepositoryContext):Promise<OutreachControl['settings']>{
 const row=(await ctx.db.query<{revision:number;routine_replies_enabled:boolean;reply_sequence_version_id:string|null;booking_url:string|null}>('SELECT * FROM outreach_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0];
 return row?{revision:row.revision,enabled:row.routine_replies_enabled,sequenceVersionId:row.reply_sequence_version_id,bookingUrl:row.booking_url}:{revision:0,enabled:false,sequenceVersionId:null,bookingUrl:null};
}
export async function saveRoutineSettings(ctx:RepositoryContext,input:unknown):Promise<Result<{revision:number}>>{
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 const parsed=routineSettingsSaveSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};const v=parsed.data;
 await lockSendGateForStopFact(ctx);const old=await readRoutineSettings(ctx);if(v.expectedRevision!==old.revision)return {ok:false,reason:'stale_revision'};
 if(v.bookingUrl!==null){try{const u=new URL(v.bookingUrl);if(u.protocol!=='https:'||u.hostname!=='cal.com'||u.username||u.password||u.hash)return {ok:false,reason:'booking_link_invalid'};}catch{return {ok:false,reason:'booking_link_invalid'};}}
 if(v.sequenceVersionId!==null&&await campaignKind(ctx,v.sequenceVersionId)!=='reply')return {ok:false,reason:'one_reply_sequence_required'};
 if(v.enabled&&(!v.sequenceVersionId||!(await listAnswerBlocks(ctx)).some(b=>b.approvedAt&&!b.retiredAt)))return {ok:false,reason:'approved_reply_content_required'};
 const revision=old.revision+1;
 await ctx.db.query(`INSERT INTO outreach_settings(workspace_id,revision,routine_replies_enabled,reply_sequence_version_id,booking_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision,routine_replies_enabled=EXCLUDED.routine_replies_enabled,reply_sequence_version_id=EXCLUDED.reply_sequence_version_id,booking_url=EXCLUDED.booking_url,updated_at=now()`,[ctx.scope.workspaceId,revision,v.enabled,v.sequenceVersionId,v.bookingUrl]);
 await recordCrmAuditEvent(ctx,{action:'outreach.reply_policy_saved',subjectKind:'workspace',subjectId:ctx.scope.workspaceId,detail:{revision,enabled:v.enabled,sequenceVersionId:v.sequenceVersionId}});
 return {ok:true,value:{revision}};
}
export async function readOutreachControl(ctx:RepositoryContext):Promise<OutreachControl>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')throw new Error('admin_required');
 const w=ctx.scope.workspaceId;
 const boxes=(await ctx.db.query<{id:string;email_address:string;owner_user_id:string;status:string;sending_enabled:boolean}>(`SELECT m.*,COALESCE(d.automated_sending_enabled,false) AS sending_enabled FROM mailboxes m LEFT JOIN sending_domains d ON d.workspace_id=m.workspace_id AND d.domain=split_part(m.email_address,'@',2) WHERE m.workspace_id=$1 ORDER BY m.email_address LIMIT 20`,[w])).rows;
 const senders:OutreachControl['senders']=[];
 for(const box of boxes){const auth=await authorizationForMailbox(ctx,box.id),ramp=await readRampStanding(ctx,box.id);senders.push({id:box.id,address:box.email_address,ownerUserId:box.owner_user_id,connected:box.status==='connected',authorized:auth.allowed,authorizationRevision:auth.revision??0,sendingEnabled:box.sending_enabled,dailyCap:ramp?.effectiveCap??null});}
 const versions=(await ctx.db.query<{id:string;name:string;version:number}>(`SELECT v.id,s.name,v.version FROM sequence_versions v JOIN sequences s ON s.workspace_id=v.workspace_id AND s.id=v.sequence_id WHERE v.workspace_id=$1 AND v.state='published' ORDER BY s.name,v.version DESC LIMIT 100`,[w])).rows;
 const sequences:OutreachControl['sequences']=[];for(const v of versions){const kind=await campaignKind(ctx,v.id);if(kind)sequences.push({id:v.id,label:`${v.name} · version ${v.version}`,kind});}
 const candidates=(await ctx.db.query<{id:string;revision:number;run_id:string;payload:{firmName:string;locality:string;region:string}}>(`SELECT c.id,c.revision,c.payload,r.id AS run_id FROM sourcing_candidates c JOIN LATERAL(SELECT id FROM sourcing_qualification_runs q WHERE q.workspace_id=c.workspace_id AND q.candidate_id=c.id AND q.candidate_revision=c.revision AND q.state IN ('eligible','review','admitted') AND q.reason IS NULL ORDER BY q.requested_at DESC,q.id DESC LIMIT 1) r ON true WHERE c.workspace_id=$1 AND NOT c.qualification_blocked AND c.status<>'dismissed' ORDER BY c.created_at DESC,c.id LIMIT 50`,[w])).rows.map(c=>({id:c.id,revision:c.revision,qualificationRunId:c.run_id,name:c.payload.firmName,location:`${c.payload.locality}, ${c.payload.region}`}));
 const replies=(await ctx.db.query<{id:string;revision:number;firm_id:string;name:string;state:string;reason:string|null;created_at:Date}>(`SELECT r.id,r.revision,p.firm_id,f.name,r.state,r.reason,r.created_at FROM outreach_reply_requests r JOIN outreach_plans p ON p.workspace_id=r.workspace_id AND p.id=r.plan_id JOIN firms f ON f.workspace_id=p.workspace_id AND f.id=p.firm_id WHERE r.workspace_id=$1 AND r.state IN ('ready','review','expired') ORDER BY r.created_at DESC,r.id LIMIT 25`,[w])).rows.map(r=>({id:r.id,revision:r.revision,firmId:r.firm_id,firmName:r.name,state:r.state,reason:r.reason,createdAt:r.created_at.toISOString()}));
 return {emailAdmission:await readEmailAdmissionControl(ctx),settings:await readRoutineSettings(ctx),blocks:await listAnswerBlocks(ctx),senders,sequences,candidates,replies};
}
export async function handleRoutineManually(ctx:RepositoryContext,input:{id:string;expectedRevision:number}):Promise<Result<{revision:number}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return {ok:false,reason:'admin_required'};
 await lockSendGateForStopFact(ctx);
 const r=(await ctx.db.query<{revision:number;plan_id:string}>('SELECT revision,plan_id FROM outreach_reply_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.id])).rows[0];if(!r)return {ok:false,reason:'not_found'};if(r.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 await ctx.db.query("UPDATE outreach_plans SET state='manual',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('stopped','completed')",[ctx.scope.workspaceId,r.plan_id]);
 const es=(await ctx.db.query<{id:string}>('SELECT id FROM sequence_enrollments WHERE workspace_id=$1 AND outreach_plan_id=$2 AND ended_at IS NULL',[ctx.scope.workspaceId,r.plan_id])).rows;
 await stopEnrollments(ctx,{enrollmentIds:es.map(e=>e.id),reason:'admin_stop'});
 await ctx.db.query("UPDATE outreach_reply_requests SET state='review',reason='manual_handling',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.id]);
 await recordCrmAuditEvent(ctx,{action:'outreach.reply_manual',subjectKind:'outreach_reply',subjectId:input.id,detail:{planId:r.plan_id}});
 return {ok:true,value:{revision:r.revision+1}};
}

export async function readOutreachSenderStanding(ctx:RepositoryContext):Promise<OutreachSenderStandingResponse>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')throw new Error('admin_required');
 const boxes=(await ctx.db.query<{id:string}>('SELECT id FROM mailboxes WHERE workspace_id=$1 ORDER BY email_address LIMIT 20',[ctx.scope.workspaceId])).rows;
 const senders:OutreachSenderStandingResponse['senders']=[];
 for(const box of boxes){
  await ensureRamp(ctx,box.id);
  const standing=await readRampStanding(ctx,box.id);
  if(standing)senders.push({mailboxId:box.id,standing:describeRampStanding(standing)});
 }
 return {senders};
}

export async function readOutreachSenderStandingV2(ctx:RepositoryContext):Promise<OutreachSenderStandingV2Response>{
 const view=await readOutreachSenderStanding(ctx);
 const senders:OutreachSenderStandingV2Response['senders']=[];
 for(const sender of view.senders)senders.push({...sender,incidents:[...await readProviderIncidents(ctx,sender.mailboxId)]});
 return {senders};
}
