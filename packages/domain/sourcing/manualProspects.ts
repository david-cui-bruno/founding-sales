import {isDeepStrictEqual} from 'node:util';
import {manualProspectListInputSchema,manualProspectListSchema,manualProspectFeedbackInputSchema,type manualProspectFeedbackSavedSchema,type ManualPhoneChoice} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {manualProspectRows,MANUAL_PROSPECT_ROWS_SQL} from './manualProspectRows.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {manualPhoneSnapshots,recheckManualPhoneSnapshots,projectManualPhone,changedManualPhone} from './manualProspectPhone.ts';
import {projectManualProspect,type ManualProspectRow} from './manualProspectProjection.ts';
import {phoneDiscoverySnapshots} from './prospectPhoneDiscoveryStore.ts';
import {composeProspectPhoneDiscovery,projectProspectPhoneDiscovery} from './prospectPhoneDiscoveryProjection.ts';
import {readProspectPhoneDiscoverySnapshot} from './prospectPhoneDiscovery.ts';
import {currentManualPhoneChoice,projectManualPhoneChoice} from './manualProspectPhoneChoice.ts';
import {lockLivePreparationCleanup} from '../calling/preparationLifecycle.ts';

type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const refuse=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
async function admin(ctx:RepositoryContext):Promise<boolean>{
 return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx);
}
/** Caller owns transaction and authenticated principal fence. No external IO. */
export async function listManualProspects(ctx:RepositoryContext,input:z.infer<typeof manualProspectListInputSchema>,authority:()=>Promise<boolean>=async()=>true):Promise<Result<z.infer<typeof manualProspectListSchema>>>{
 if(!await admin(ctx))return refuse('admin_only');
 if(!manualProspectListInputSchema.safeParse(input).success)return refuse('invalid_input');
 await lockDiscoveryReviewSources(ctx);
 const exact=input.candidateId&&input.expectedRevision?{candidateId:input.candidateId,expectedRevision:input.expectedRevision}:undefined;
 const rows=await manualProspectRows(ctx,input.state,input.offset,exact),page=rows.slice(0,50);
 if(page.length)await lockLivePreparationCleanup(ctx);
 if(page.length)await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',[ctx.scope.workspaceId,page.map(row=>row.id)]);
 // Choice metadata belongs only to this opted-in projection. Raw source authority
 // remains independent of schema143 and reusable by historical migration checks.
 const choices=input.includeManualPhone&&page.length?(await ctx.db.query<{candidate_id:string;candidate_revision:number;manual_phone_choice:unknown}>(
  'SELECT candidate_id,candidate_revision,manual_phone_choice FROM sourcing_manual_prospect_states WHERE workspace_id=$1 AND candidate_id=ANY($2::uuid[]) ORDER BY candidate_id FOR SHARE',
  [ctx.scope.workspaceId,page.map(row=>row.id)])).rows:[];
 const phones=await manualPhoneSnapshots(ctx,page);
 const discoveries=await phoneDiscoverySnapshots(ctx,page);
 if(ctx.scope.actor.kind==='user')await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[ctx.scope.workspaceId,ctx.scope.actor.userId]);
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const checked=await recheckManualPhoneSnapshots(ctx,page,phones);
 if(!await authority()||!await admin(ctx))return refuse('authority_changed');
 const currentRows=await manualProspectRows(ctx,input.state,input.offset,exact),currentPhones=await recheckManualPhoneSnapshots(ctx,page,phones);
 const currentDiscoveries=await phoneDiscoverySnapshots(ctx,page);
 if(!isDeepStrictEqual(rows,currentRows))return refuse('authority_changed');
 // Authority owns session/device/membership SHARE locks through this transaction.
 // Read clock-based rights after that final authority wait, not before it.
 const wall=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.getTime();
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
  const manualPhone=input.includeManualPhone&&row.manual_state==='kept'&&isDeepStrictEqual(discovered,currentDiscovery)?projectManualPhoneChoice(currentDiscovery,choice?.manual_phone_choice,wall):null;
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
 const row=(await ctx.db.query<ManualProspectRow>(`SELECT * FROM (${MANUAL_PROSPECT_ROWS_SQL}) visible WHERE id=$3`,[w,'all',input.candidateId])).rows[0];
 if(!row||!projectManualProspect(row))return refuse('candidate_unavailable');
 const choiceProvided=Object.hasOwn(input,'phoneChoice');
 let phoneChoice:ManualPhoneChoice|null=null;
 if(input.phoneChoice){
  const snapshot=await readProspectPhoneDiscoverySnapshot(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedRevision},authority);
  if(!snapshot.ok)return snapshot;
  phoneChoice=currentManualPhoneChoice(snapshot.value?.run,input.phoneChoice,snapshot.value?.now??NaN);
  if(!phoneChoice)return refuse('phone_source_changed');
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
 const snapshot=await readProspectPhoneDiscoverySnapshot(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedRevision},authority);
 if(!snapshot.ok)throw new ManualPhoneChoiceChanged(snapshot.reason);
 if(!currentManualPhoneChoice(snapshot.value?.run,input.phoneChoice,snapshot.value?.now??NaN))throw new ManualPhoneChoiceChanged('phone_source_changed');
}
