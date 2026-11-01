import {isDeepStrictEqual} from 'node:util';
import {manualProspectListInputSchema,manualProspectListSchema,manualProspectFeedbackInputSchema,type manualProspectFeedbackSavedSchema,type ManualPhoneChoice} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {manualProspectRows,MANUAL_PROSPECT_SELECTION_ROWS_SQL} from './manualProspectRows.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {manualPhoneSnapshots,recheckManualPhoneSnapshots,projectManualPhone,changedManualPhone,type ManualPhoneSnapshot} from './manualProspectPhone.ts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';
import {phoneDiscoverySnapshots} from './prospectPhoneDiscoveryStore.ts';
import {composeProspectPhoneDiscovery,projectProspectPhoneDiscovery} from './prospectPhoneDiscoveryProjection.ts';
import {readProspectPhoneDiscoverySnapshot} from './prospectPhoneDiscovery.ts';
import {currentManualPhoneChoice,projectManualPhoneChoice,projectPreparedPhoneChoice} from './manualProspectPhoneChoice.ts';
import {readPreparedPhoneChoice,withPreparedPhoneSnapshots} from './manualProspectPreparedPhone.ts';
import {lockPreparedCaptureDependencies} from './preparedCaptureDependencies.ts';
import {lockLivePreparationCleanup} from '../calling/preparationLifecycle.ts';
import {readManualProspectSubject} from './manualProspectRows.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const refuse=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
async function admin(ctx:RepositoryContext):Promise<boolean>{
 return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);
}
/** Caller owns transaction and authenticated principal fence. No external IO. */
export async function listManualProspects(ctx:RepositoryContext,input:z.infer<typeof manualProspectListInputSchema>,authority:()=>Promise<boolean>=async()=>true):Promise<Result<z.infer<typeof manualProspectListSchema>>>{
 return projectManualProspectPage(ctx,input,authority,()=>manualProspectRows(ctx,input.state,input.offset,input.candidateId&&input.expectedRevision?{candidateId:input.candidateId,expectedRevision:input.expectedRevision}:undefined));
}
/** Current priority owner selects a bounded page globally, then uses this same
 * batched phone/source projection and final-clock checks as the historical list. */
export async function listManualProspectSelection(ctx:RepositoryContext,input:z.infer<typeof manualProspectListInputSchema>,selection:readonly {id:string;revision:number}[],authority:()=>Promise<boolean>,onFinalClock?:(now:number)=>void){
 if(selection.length>50)return refuse('invalid_input');
 const read=async():Promise<ManualProspectRow[]>=>{
  const found=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_SELECTION_ROWS_SQL}) current_rows WHERE id=ANY($3::uuid[])`,[ctx.scope.workspaceId,input.state,selection.map(r=>r.id)])).rows;
  return selection.flatMap(subject=>{const row=found.find(r=>r.id===subject.id&&r.revision===subject.revision);return row?[row]:[];});
 };
 return projectManualProspectPage(ctx,input,authority,read,onFinalClock);
}
async function projectManualProspectPage(ctx:RepositoryContext,input:z.infer<typeof manualProspectListInputSchema>,authority:()=>Promise<boolean>,readRows:()=>Promise<ManualProspectRow[]>,onFinalClock?:(now:number)=>void):Promise<Result<z.infer<typeof manualProspectListSchema>>>{
 if(!await admin(ctx))return refuse('admin_only');
 if(!manualProspectListInputSchema.safeParse(input).success)return refuse('invalid_input');
 await lockDiscoveryReviewSources(ctx);
 const rows=await readRows(),page=rows.slice(0,50);
 if(page.length)await lockLivePreparationCleanup(ctx);
 if(page.length)await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[ctx.scope.workspaceId,page.map(row=>row.id)]);
 // Choice metadata belongs only to this opted-in projection. Raw source authority
 // remains independent of schema143 and reusable by historical migration checks.
 const choices=input.includeManualPhone&&page.length?(await ctx.db.query<{candidate_id:string;candidate_revision:number;manual_phone_choice:unknown}>(
  'SELECT candidate_id,candidate_revision,manual_phone_choice FROM sourcing_manual_prospect_states WHERE workspace_id=$1 AND candidate_id=ANY($2::uuid[]) ORDER BY candidate_id FOR SHARE',
  [ctx.scope.workspaceId,page.map(row=>row.id)])).rows:[];
 // Calling's exact read (includeManualPhone) also reads a current prepared source association (ADR0034);
 // the default queue list is unchanged. Lock order matches the prepared reads: dependencies before exact evidence.
 const withPrepared=(snapshots:ManualPhoneSnapshot[])=>input.includeManualPhone?withPreparedPhoneSnapshots(ctx,page,snapshots):Promise.resolve(snapshots);
 if(input.includeManualPhone&&page.length)await lockPreparedCaptureDependencies(ctx,page);
 const phones=await withPrepared(await manualPhoneSnapshots(ctx,page));
 const discoveries=await phoneDiscoverySnapshots(ctx,page);
 if(ctx.scope.actor.kind==='user')await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,ctx.scope.actor.userId]);
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const checked=await withPrepared(await recheckManualPhoneSnapshots(ctx,page,phones));
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const currentRows=await readRows(),currentPhones=await withPrepared(await recheckManualPhoneSnapshots(ctx,page,phones));
 const currentDiscoveries=await phoneDiscoverySnapshots(ctx,page);
 if(!isDeepStrictEqual(rows,currentRows))return refuse('authority_changed');
 // Authority owns session/device/membership SHARE locks through this transaction.
 // Read clock-based rights after that final authority wait, not before it.
 const wall=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
 onFinalClock?.(wall);
 // Optional evidence changing during waits drops enrichment, never the raw queue.
 const prospects=page.flatMap(row=>{
  const before=phones.find(phone=>phone.candidate_id===row.id&&phone.candidate_revision===row.revision);
  const after=currentPhones.find(phone=>phone.candidate_id===row.id&&phone.candidate_revision===row.revision);
  const middle=checked.find(phone=>phone.candidate_id===row.id&&phone.candidate_revision===row.revision);
  const evidence=isDeepStrictEqual(before,middle)&&isDeepStrictEqual(before,after)?projectManualPhone(after,wall):changedManualPhone();
  const discovered=discoveries.find(run=>run.candidate_id===row.id&&run.candidate_revision===row.revision);
  const currentDiscovery=currentDiscoveries.find(run=>run.candidate_id===row.id&&run.candidate_revision===row.revision);
  const discoveryEvidence=!isDeepStrictEqual(discovered,currentDiscovery)?changedManualPhone():currentDiscovery?projectProspectPhoneDiscovery(currentDiscovery,wall):null;
  const p=projectManualProspect(row,composeProspectPhoneDiscovery(evidence,discoveryEvidence));
  if(!p)return [];
  const choice=choices.find(value=>value.candidate_id===row.id&&value.candidate_revision===row.revision);
  const stable=isDeepStrictEqual(before,middle)&&isDeepStrictEqual(before,after);
  const stored=input.includeManualPhone&&row.manual_state==='kept'?choice?.manual_phone_choice:undefined;
  // A choice names either its phone-discovery run or the candidate's latest qualification run (prepared pages, ADR0034).
  const manualPhone=stored===undefined?null:isDeepStrictEqual(discovered,currentDiscovery)?projectManualPhoneChoice(currentDiscovery,stored,wall)??(stable?projectPreparedPhoneChoice(after,stored,wall):null):null;
  return [manualPhone?{...p,manualPhone}:p];
 });
 return {ok:true,value:manualProspectListSchema.parse({prospects,hasMore:rows.length>50})};
}
/** Manual state is not canonical candidate review, qualification or channel suppression.
 * Candidate lock precedes live membership and session revalidation after waits.
 */
export async function recordManualProspectFeedback(ctx:RepositoryContext,input:z.infer<typeof manualProspectFeedbackInputSchema>,authority:()=>Promise<boolean>=async()=>true):Promise<Result<z.infer<typeof manualProspectFeedbackSavedSchema>>>{
 if(!await admin(ctx)||ctx.scope.actor.kind!=='user')return refuse('admin_only');
 if(!manualProspectFeedbackInputSchema.safeParse(input).success)return refuse('invalid_input');
 const w=ctx.scope.workspaceId;
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${w}`]);
 await lockLivePreparationCleanup(ctx);
 const candidate=(await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.candidateId])).rows[0];
 if(!candidate)return refuse('candidate_unavailable');
 if(candidate.revision!==input.expectedRevision)return refuse('candidate_changed');
 await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[w,ctx.scope.actor.userId]);
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const row=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_SELECTION_ROWS_SQL}) visible WHERE id=ANY($3::uuid[])`,[w,'all',[input.candidateId]])).rows[0];
 if(!row||!projectManualProspect(row))return refuse('candidate_unavailable');
 const choiceProvided=Object.hasOwn(input,'phoneChoice');
 let phoneChoice:ManualPhoneChoice|null=null;
 if(input.phoneChoice){
  // A choice from this candidate's prepared pages (its latest qualification run) is read before any discovery run.
  const prepared=await readPreparedPhoneChoice(ctx,row,input.phoneChoice,authority);
  if(!prepared.ok)return refuse(prepared.reason);
  if(prepared.matched){
   if(!prepared.phone)return refuse('phone_source_changed');
   phoneChoice=prepared.phone.choice;
  }else{
   const snapshot=await readProspectPhoneDiscoverySnapshot(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedRevision},authority);
   if(!snapshot.ok)return snapshot;
   phoneChoice=currentManualPhoneChoice(snapshot.value?.run,input.phoneChoice,snapshot.value?.now??NaN);
   if(!phoneChoice)return refuse('phone_source_changed');
  }
 }
 await ctx.db.query(`INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state,manual_phone_choice) VALUES($1,$2,$3,$4,$6::jsonb)
 ON CONFLICT(workspace_id,candidate_id) DO UPDATE SET candidate_revision=EXCLUDED.candidate_revision,state=EXCLUDED.state,updated_at=clock_timestamp(),
 manual_phone_choice=CASE WHEN EXCLUDED.state<>'kept' THEN NULL WHEN $5::boolean THEN EXCLUDED.manual_phone_choice
 WHEN sourcing_manual_prospect_states.candidate_revision=EXCLUDED.candidate_revision AND sourcing_manual_prospect_states.state='kept' THEN sourcing_manual_prospect_states.manual_phone_choice ELSE NULL END`,
 [w,input.candidateId,input.expectedRevision,input.state,choiceProvided,phoneChoice?JSON.stringify(phoneChoice):null]);
 return {ok:true,value:{candidateId:input.candidateId,revision:input.expectedRevision,state:input.state,...(choiceProvided?{phoneChoice}:{})}};
}

export class ManualPhoneChoiceChanged extends Error{constructor(readonly reason:string){super(reason);this.name='ManualPhoneChoiceChanged';}}
/** Receipt/audit insertion can wait after the annotation write. Throw to roll the
 * choice and receipt back together if current source or principal rights expired. */
export async function currentManualPhoneChoiceAuthority(ctx:RepositoryContext,input:{candidateId:string;expectedRevision:number;phoneChoice:ManualPhoneChoice},authority:()=>Promise<boolean>):Promise<void>{
 const subject=await readManualProspectSubject(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedRevision});
 const prepared=subject?await readPreparedPhoneChoice(ctx,{...subject,duplicate_count:0},input.phoneChoice,authority):null;
 if(prepared&&!prepared.ok)throw new ManualPhoneChoiceChanged(prepared.reason);
 if(prepared?.matched){if(!prepared.phone)throw new ManualPhoneChoiceChanged('phone_source_changed');return;}
 const snapshot=await readProspectPhoneDiscoverySnapshot(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedRevision},authority);
 if(!snapshot.ok)throw new ManualPhoneChoiceChanged(snapshot.reason);
 if(!currentManualPhoneChoice(snapshot.value?.run,input.phoneChoice,snapshot.value?.now??NaN))throw new ManualPhoneChoiceChanged('phone_source_changed');
}
