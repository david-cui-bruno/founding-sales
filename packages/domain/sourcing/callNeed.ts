import {callNeedSaveSchema,type CallNeedSave,type CallNeedView,type QualificationAnswer} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readFirm,loadFirmForUpdate} from '../crm/firms.ts';
import {decideFirmRead,decideFirmMutation} from '../crm/authorization.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import type {SourcingResult} from './qualificationStore.ts';
export const ANSWERED_CALL_OUTCOMES=['interested','referral_or_wrong_person','callback_requested','not_interested','do_not_call'] as const;
type Source={id:string;firm_id:string;outcome:string;source_revision:number};
async function locate(ctx:RepositoryContext,input:{callLogId:string}|{sessionId:string}):Promise<Source|null>{
 const bySession='sessionId' in input;
 return (await ctx.db.query<Source>(`SELECT l.id,l.firm_id,l.outcome,
  (SELECT count(*)::int FROM audit_events a WHERE a.workspace_id=l.workspace_id AND a.subject_kind='call_log' AND a.subject_id=l.id::text AND a.action='call.outcome_corrected') AS source_revision
  FROM call_logs l WHERE l.workspace_id=$1 AND ${bySession?'l.id=(SELECT s.call_log_id FROM call_sessions s WHERE s.workspace_id=l.workspace_id AND s.id=$2)':'l.id=$2'}`,
 [ctx.scope.workspaceId,bySession?input.sessionId:input.callLogId])).rows[0]??null;
}
export async function readCallNeed(ctx:RepositoryContext,input:{callLogId:string}|{sessionId:string}):Promise<CallNeedView|null>{
 const source=await locate(ctx,input);if(!source)return null;
 const firm=await readFirm(ctx,source.firm_id);if(!firm||firm.status==='merged'||decideFirmRead(ctx,firm)!=='assigned_or_admin')return null;
 const row=(await ctx.db.query<{revision:number;source_revision:number;source_outcome:string;answer:QualificationAnswer}>('SELECT revision,source_revision,source_outcome,answer FROM call_need_revisions WHERE workspace_id=$1 AND call_log_id=$2 ORDER BY revision DESC LIMIT 1',[ctx.scope.workspaceId,source.id])).rows[0];
 const canConfirm=(ANSWERED_CALL_OUTCOMES as readonly string[]).includes(source.outcome);
 const stale=!!row&&(row.source_revision!==source.source_revision||row.source_outcome!==source.outcome);
 const final=await locate(ctx,input),currentFirm=await readFirm(ctx,source.firm_id);
 if(!final||JSON.stringify(final)!==JSON.stringify(source)||!currentFirm||currentFirm.status==='merged'||decideFirmRead(ctx,currentFirm)!=='assigned_or_admin')return null;
 return {callLogId:source.id,revision:row?.revision??0,sourceRevision:source.source_revision,answer:canConfirm&&!stale?row?.answer??'unknown':'unknown',stale,canConfirm};
}
/** User confirmation is explicitly bound to this call outcome revision, never inferred from interest. */
export async function saveCallNeed(ctx:RepositoryContext,input:CallNeedSave):Promise<SourcingResult<{revision:number}>>{
 if(ctx.scope.actor.kind!=='user'||!callNeedSaveSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 await lockSendGateForStopFact(ctx);
 const initial=await locate(ctx,{callLogId:input.callLogId});if(!initial)return {ok:false,reason:'not_found'};
 const firm=await loadFirmForUpdate(ctx,initial.firm_id);if(!firm||firm.status==='merged'||!decideFirmMutation(ctx,firm).permitted)return {ok:false,reason:'not_found'};
 await ctx.db.query('SELECT id FROM call_logs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.callLogId]);
 const current=await readCallNeed(ctx,{callLogId:input.callLogId});if(!current)return {ok:false,reason:'not_found'};
 if(current.sourceRevision!==input.expectedSourceRevision)return {ok:false,reason:'source_changed'};
 if(current.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 if(!current.canConfirm&&input.answer!=='unknown')return {ok:false,reason:'call_not_answered'};
 const source=await locate(ctx,{callLogId:input.callLogId});if(!source||source.firm_id!==firm.id)return {ok:false,reason:'source_changed'};
 const revision=current.revision+1;
 await ctx.db.query(`INSERT INTO call_need_revisions(workspace_id,call_log_id,revision,source_revision,source_outcome,answer,command_id,confirmed_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[ctx.scope.workspaceId,input.callLogId,revision,current.sourceRevision,source.outcome,input.answer,input.commandId,ctx.scope.actor.userId]);
 await recordCrmAuditEvent(ctx,{action:'call.need_confirmed',subjectKind:'call_log',subjectId:input.callLogId,detail:{revision,sourceRevision:current.sourceRevision,answer:input.answer,commandId:input.commandId}});
 return {ok:true,value:{revision}};
}
