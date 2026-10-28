import {randomUUID} from 'node:crypto';
import {callingPreparationInputSchema,callingPreparationReadSchema,callingPreparationReceiptSchema,CALLING_PREPARATION_COMMAND_KIND,
 type CallingPreparationSelection,type CallingPreparationInput,type CallingPreparationRead,type CallingPreparationSaved,type CallingPreparationReceipt} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {createFirm} from '../crm/firms.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {isKnownTimeZone} from '../src/rules/localClock.ts';
import {phoneDiscoveryAdmin,phoneDiscoveryNow} from '../sourcing/prospectPhoneDiscoveryAuthority.ts';
import {lockDiscoveryReviewSources} from '../sourcing/discoveryReviewVisibility.ts';
import {readPreparationSource,preparationSelection,samePreparationChoice,type PreparationAuthority,type PreparationResult} from './preparationSource.ts';
import {lockPreparationCleanup} from './preparationLifecycle.ts';
import {preparationForCandidate,preparationForFirm,plannedProfileHash,storedPreparedProfile,writePreparedProfile,preparationDuplicates} from './preparationStore.ts';

export class CallingPreparationChanged extends Error{constructor(readonly reason:string){super(reason);}}
async function currentAdmin(ctx:RepositoryContext,authority:PreparationAuthority):Promise<boolean>{
 return ctx.scope.actor.kind==='user'&&ctx.scope.actor.role==='admin'&&await activeIdentityActor(ctx)&&await authority();
}
/** Strictly read-only preparation preview; no run invalidation or acquisition. */
export async function readCallingPreparation(ctx:RepositoryContext,input:CallingPreparationSelection,authority:PreparationAuthority):Promise<CallingPreparationRead>{
 if(!await currentAdmin(ctx,authority))return {state:'refused',reason:'admin_only'};
 await lockDiscoveryReviewSources(ctx);
 const prep=await preparationForCandidate(ctx,input.candidateId);
 const source=await readPreparationSource(ctx,input,authority);
 if(!await currentAdmin(ctx,authority))throw new CallingPreparationChanged('authority_changed');
 if(prep?.state==='erased'||prep&&!source.ok)return {state:'withdrawn',preparationId:prep.id,revision:prep.revision,reason:'source_withdrawn'};
 if(!source.ok)return {state:'refused',reason:source.reason};
 if(prep&&(prep.candidate_revision!==input.expectedCandidateRevision||!await phoneDiscoveryAdmin(ctx,prep.prepared_by_ref)))return {state:'withdrawn',preparationId:prep.id,revision:prep.revision,reason:'source_withdrawn'};
 if(prep){
  const boundSelection=preparationSelection(prep.candidate_ref,prep.candidate_revision,prep.choice);
  if(!boundSelection||!samePreparationChoice(boundSelection.choice,input.choice))return {state:'withdrawn',preparationId:prep.id,revision:prep.revision,reason:'source_withdrawn'};
  try{await requireCurrentCallingPreparation(ctx,prep.firm_ref,authority);}catch(error){
   if(error instanceof CallingPreparationChanged)return {state:'withdrawn',preparationId:prep.id,revision:prep.revision,reason:'source_withdrawn'};
   throw error;
  }
 }
 const profile=prep?await storedPreparedProfile(ctx,prep.firm_ref):source.value.profile;
 if(!profile)return {state:'refused',reason:'firm_changed'};
 const duplicates=await preparationDuplicates(ctx,profile,source.value.phone.value,prep?.firm_ref??null);
 const final=await readPreparationSource(ctx,input,authority);
 if(!final.ok||!await currentAdmin(ctx,authority))throw new CallingPreparationChanged(final.ok?'authority_changed':final.reason);
 const boundExpiry=prep?await requireCurrentCallingPreparation(ctx,prep.firm_ref,authority):null;
 const phone={...final.value.phone,expiresAt:boundExpiry??final.value.phone.expiresAt};
 return callingPreparationReadSchema.parse({state:'available',selection:input,phone,profile,
  binding:prep?{preparationId:prep.id,revision:prep.revision,firmId:prep.firm_ref,routeId:prep.route_ref,routeVersion:prep.route_version}:null,
  duplicates:{possibleDuplicateFirmIds:duplicates.slice(0,20),possibleDuplicateCount:duplicates.length,nextAction:duplicates.length?'select_recorded_company':'review_preparation'},
  unknowns:['company_identity_unverified','residential_fit_unverified',...(profile.addressLine?[]:['office_address_unknown']),'phone_type_unverified',
   ...(profile.timeZone.kind==='unknown'?['time_zone_unknown']:[]),'decision_maker_unknown'],qualification:'unverified',contactAuthority:'not_granted',
  fieldOwnership:'source_bound',researchPolicy:prep?'paused_before_enqueue':'required_before_enqueue'});
}
/** Existing creation/route/hold owners, with one transaction and no wire bypass. */
export async function confirmCallingPreparation(ctx:RepositoryContext,raw:CallingPreparationInput,authority:PreparationAuthority):Promise<PreparationResult<CallingPreparationSaved>>{
 if(!await currentAdmin(ctx,authority)||ctx.scope.actor.kind!=='user')return {ok:false,reason:'admin_only'};
 const parsed=callingPreparationInputSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'profile_invalid'};
 const input=parsed.data,profile=input.reviewedProfile;
 if(profile.timeZone.kind==='reviewed'&&!isKnownTimeZone(profile.timeZone.timeZone))return {ok:false,reason:'profile_invalid'};
 await lockPreparationCleanup(ctx);
 const existing=await preparationForCandidate(ctx,input.selection.candidateId);
 if(existing?.state==='erased')return {ok:false,reason:'preparation_terminal'};
 const source=await readPreparationSource(ctx,input.selection,authority);if(!source.ok)return source;
 if(input.expected.state==='absent'&&existing||input.expected.state==='live'&&(!existing||existing.id!==input.expected.preparationId||existing.revision!==input.expected.revision||existing.route_version!==input.expected.routeVersion))return {ok:false,reason:'preparation_version_conflict'};
 if(existing&&existing.candidate_revision!==input.selection.expectedCandidateRevision)return {ok:false,reason:'candidate_changed'};
 if(existing){
  const selection=preparationSelection(existing.candidate_ref,existing.candidate_revision,existing.choice);
  if(!selection||!samePreparationChoice(selection.choice,input.selection.choice))return {ok:false,reason:'choice_changed'};
  await requireCurrentCallingPreparation(ctx,existing.firm_ref,authority);
 }
 if((await preparationDuplicates(ctx,profile,source.value.phone.value,existing?.firm_ref??null)).length)return {ok:false,reason:'duplicate_recorded_company'};
 if(!await currentAdmin(ctx,authority))throw new CallingPreparationChanged('authority_changed');
 const w=ctx.scope.workspaceId,id=existing?.id??randomUUID(),firmId=existing?.firm_ref??randomUUID(),routeId=existing?.route_ref??randomUUID();
 const hash=await plannedProfileHash(ctx,profile);
 if(!existing){
  await ctx.db.query(`INSERT INTO calling_preparations(workspace_id,id,candidate_ref,candidate_revision,discovery_run_ref,source_creator_ref,prepared_by_ref,
   firm_ref,route_ref,firm_id,phone_route_id,choice,source_url_hashes,profile_hash,source_expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10::jsonb,$11::text[],$12,$13)`,
  [w,id,input.selection.candidateId,input.selection.expectedCandidateRevision,source.value.run.id,source.value.run.creator_user_id,ctx.scope.actor.userId,
   firmId,routeId,JSON.stringify(input.selection.choice),source.value.sourceHashes,hash,source.value.phone.expiresAt]);
  const created=await createFirm(ctx,{name:profile.companyName,website:profile.website??undefined,addressLine:profile.addressLine??undefined,
   locality:profile.locality??undefined,regionCode:profile.regionCode??undefined,postalCode:profile.postalCode??undefined,countryCode:'US',assignedUserId:ctx.scope.actor.userId,
   callingPreparation:{id,firmId,timeZone:profile.timeZone.kind==='reviewed'?profile.timeZone.timeZone:null}});
  if(!created.ok)throw new CallingPreparationChanged(created.reason);
  await ctx.db.query(`INSERT INTO phone_routes(workspace_id,id,firm_id,e164,source,retrieved_at,technical_validation,eligibility,calling_preparation_id)
   VALUES($1,$2,$3,$4,'website',$5,'unknown','candidate',$6)`,[w,routeId,firmId,source.value.phone.value,source.value.phone.retrievedAt,id]);
 }else{
  if(!await phoneDiscoveryAdmin(ctx,existing.prepared_by_ref))return {ok:false,reason:'creator_inactive'};
  await ctx.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,firmId]);
  await writePreparedProfile(ctx,firmId,profile);
  await ctx.db.query('UPDATE phone_routes SET version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[w,routeId]);
  await ctx.db.query(`UPDATE calling_preparations SET revision=revision+1,route_version=route_version+1,profile_hash=$3,
   source_expires_at=LEAST(source_expires_at,$4::timestamptz),updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[w,id,hash,source.value.phone.expiresAt]);
 }
 const saved=await preparationForCandidate(ctx,input.selection.candidateId);if(!saved)throw Error('Preparation missing');
 await recordCrmAuditEvent(ctx,{action:'calling.preparation_confirmed',subjectKind:'calling_preparation',subjectId:id,detail:{revision:saved.revision}});
 await requireCurrentCallingPreparation(ctx,firmId,authority);
 return {ok:true,value:{preparationId:id,revision:saved.revision,firmId,routeId,historicalState:'prepared'}};
}
/** Called again after receipt/audit waits. A failure rolls back every new effect. */
export async function requireCurrentCallingPreparation(ctx:RepositoryContext,firmId:string,authority:PreparationAuthority=async()=>true):Promise<string|null>{
 const p=await preparationForFirm(ctx,firmId);if(!p)return null;
 const input=preparationSelection(p.candidate_ref,p.candidate_revision,p.choice);
 if(p.state!=='live'||!input||!await phoneDiscoveryAdmin(ctx,p.prepared_by_ref))throw new CallingPreparationChanged('source_withdrawn');
 const source=await readPreparationSource(ctx,input,authority);if(!source.ok)throw new CallingPreparationChanged(source.reason);
 if(source.value.run.creator_user_id!==p.source_creator_ref||source.value.run.id!==p.discovery_run_ref)throw new CallingPreparationChanged('source_withdrawn');
 const rows=await ctx.db.query(`SELECT 1 FROM firms f JOIN phone_routes r ON r.workspace_id=f.workspace_id AND r.firm_id=f.id
  WHERE f.workspace_id=$1 AND f.id=$2 AND f.status='active' AND f.calling_preparation_id=$3 AND f.calling_preparation_erased_at IS NULL
  AND r.id=$4 AND r.version=$5 AND r.e164=$6 AND r.calling_preparation_id=$3 AND r.calling_preparation_erased_at IS NULL
  AND calling_preparation_profile_hash($1,$2)=$7`,[ctx.scope.workspaceId,firmId,p.id,p.route_ref,p.route_version,source.value.phone.value,p.profile_hash]);
 const expiry=Math.min(p.source_expires_at.getTime(),Date.parse(source.value.phone.expiresAt));
 if(!rows.rows.length||expiry<=(await phoneDiscoveryNow(ctx)).getTime()||!await authority()||!await activeIdentityActor(ctx))throw new CallingPreparationChanged('source_withdrawn');
 if(expiry<=(await phoneDiscoveryNow(ctx)).getTime())throw new CallingPreparationChanged('source_withdrawn');
 return new Date(expiry).toISOString();
}
/** Historical receipt only, narrowly bound to original user/device/kind/hash. */
export async function readCallingPreparationReceipt(ctx:RepositoryContext,input:{commandId:string;payloadSHA256:string},deviceId:string,authority:PreparationAuthority):Promise<CallingPreparationReceipt>{
 if(!await currentAdmin(ctx,authority)||ctx.scope.actor.kind!=='user')throw new CallingPreparationChanged('authority_changed');
 const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
  WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
 [ctx.scope.workspaceId,input.commandId,deviceId,ctx.scope.actor.userId,CALLING_PREPARATION_COMMAND_KIND,input.payloadSHA256])).rows[0];
 if(!await currentAdmin(ctx,authority))throw new CallingPreparationChanged('authority_changed');
 return callingPreparationReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:row.result});
}
