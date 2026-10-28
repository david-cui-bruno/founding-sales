import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {manualPhoneChoiceSchema,type CallingPreparationSelection,type CallingPreparationProfile,type ManualPhoneChoice} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockPhoneDiscoveryCandidate,phoneDiscoveryRun,validatePhoneDiscoveryRun,type PhoneDiscoveryRun} from '../sourcing/prospectPhoneDiscoveryStore.ts';
import {phoneDiscoveryAdmin,phoneDiscoveryNow} from '../sourcing/prospectPhoneDiscoveryAuthority.ts';
import {readManualProspectSubject} from '../sourcing/manualProspectRows.ts';
import {projectManualProspect} from '../sourcing/manualProspectProjection.ts';
import {projectManualPhoneChoice} from '../sourcing/manualProspectPhoneChoice.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';

export type PreparationRefusal='admin_only'|'candidate_unavailable'|'candidate_changed'|'choice_not_kept'|'choice_changed'|'source_withdrawn'|'creator_inactive'|'authority_changed'|'preparation_version_conflict'|'preparation_terminal'|'profile_invalid'|'duplicate_recorded_company'|'office_country_unresolved'|'firm_changed'|'route_changed';
export type PreparationResult<T>={ok:true;value:T}|{ok:false;reason:PreparationRefusal};
export type PreparationAuthority=()=>Promise<boolean>;
export interface PreparationSource{
 selection:CallingPreparationSelection;run:PhoneDiscoveryRun;
 phone:NonNullable<ReturnType<typeof projectManualPhoneChoice>>;
 profile:CallingPreparationProfile;sourceHashes:string[];
}
/** Internal current-source composition, also used for assigned-member execution.
 * Public source reads/confirmation separately enforce admin. Never impersonates
 * the creator, fetches, extends expiry or invalidates a run during a read/consume.
 */
export async function readPreparationSource(ctx:RepositoryContext,selection:CallingPreparationSelection,authority:PreparationAuthority,snapshot=false):Promise<PreparationResult<PreparationSource>>{
 const candidate=snapshot?(await ctx.db.query<{revision:number}>('SELECT revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,selection.candidateId])).rows[0]:await lockPhoneDiscoveryCandidate(ctx,selection.candidateId);
 if(!candidate)return {ok:false,reason:'candidate_unavailable'};
 if(candidate.revision!==selection.expectedCandidateRevision)return {ok:false,reason:'candidate_changed'};
 if((await ctx.db.query<{qualification_blocked:boolean}>('SELECT qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,selection.candidateId])).rows[0]?.qualification_blocked)return {ok:false,reason:'source_withdrawn'};
 const state=(await ctx.db.query<{state:string;candidate_revision:number;manual_phone_choice:unknown}>(
  `SELECT state,candidate_revision,manual_phone_choice FROM sourcing_manual_prospect_states WHERE workspace_id=$1 AND candidate_id=$2${snapshot?'':' FOR SHARE'}`,
  [ctx.scope.workspaceId,selection.candidateId])).rows[0];
 if(!state||state.state!=='kept'||state.candidate_revision!==candidate.revision)return {ok:false,reason:'choice_not_kept'};
 const saved=manualPhoneChoiceSchema.safeParse(state.manual_phone_choice);
 if(!saved.success||!isDeepStrictEqual(saved.data,selection.choice))return {ok:false,reason:'choice_changed'};
 const row=await readManualProspectSubject(ctx,{candidateId:selection.candidateId,expectedRevision:selection.expectedCandidateRevision});
 const prospect=row?projectManualProspect({...row,duplicate_count:0}):null;
 if(!prospect)return {ok:false,reason:'source_withdrawn'};
 const run=await phoneDiscoveryRun(ctx,selection.candidateId,selection.expectedCandidateRevision,snapshot);
 if(!run||run.id!==selection.choice.runId||run.state!=='complete'||!run.content)return {ok:false,reason:'source_withdrawn'};
 if(!await phoneDiscoveryAdmin(ctx,run.creator_user_id,!snapshot))return {ok:false,reason:'creator_inactive'};
 if(!await activeIdentityActor(ctx)||!await authority())return {ok:false,reason:'authority_changed'};
 if(await validatePhoneDiscoveryRun(ctx,run,false,true,!snapshot))return {ok:false,reason:'source_withdrawn'};
 const phone=projectManualPhoneChoice(run,selection.choice,(await phoneDiscoveryNow(ctx)).getTime());
 if(!phone)return {ok:false,reason:'source_withdrawn'};
 // Recheck after exact principal waits, using fresh trusted wall time and the same
 // granting source rules. The normal source lifecycle lock remains held.
 if(!await authority()||!await activeIdentityActor(ctx))return {ok:false,reason:'authority_changed'};
 if(await validatePhoneDiscoveryRun(ctx,run,false,true,!snapshot))return {ok:false,reason:'source_withdrawn'};
 const finalPhone=projectManualPhoneChoice(run,selection.choice,(await phoneDiscoveryNow(ctx)).getTime());
 if(!finalPhone)return {ok:false,reason:'source_withdrawn'};
 const urls=[run.content.website,...run.content.sourceUrls,...run.content.observations.map(o=>o.url)];
 const sourceHashes=[...new Set(urls.map(url=>createHash('sha256').update(url.replace(/\/+$/u,'')).digest('hex')))].sort();
 return {ok:true,value:{selection,run,phone:finalPhone,sourceHashes,profile:{
  companyName:prospect.presentation?.label??prospect.observedName,
  website:prospect.website&&prospect.website.length<=500?prospect.website:null,addressLine:null,
  locality:prospect.locality&&prospect.locality.length<=120?prospect.locality:null,
  regionCode:prospect.region&&/^[A-Z]{2}$/u.test(prospect.region)?prospect.region:null,
  postalCode:null,countryCode:null,timeZone:{kind:'unknown'},
 }}};
}
export function preparationSelection(candidateId:string,revision:number,choice:unknown):CallingPreparationSelection|null{
 const parsed=manualPhoneChoiceSchema.safeParse(choice);
 return parsed.success?{candidateId,expectedCandidateRevision:revision,choice:parsed.data}:null;
}
export const samePreparationChoice=(left:ManualPhoneChoice,right:ManualPhoneChoice)=>isDeepStrictEqual(left,right);
