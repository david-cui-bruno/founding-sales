import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {manualPhoneChoiceSchema,type CallingPreparationSelection,type CallingPreparationProfile,type ManualPhoneChoice} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockPhoneDiscoveryCandidate,phoneDiscoveryRun,validatePhoneDiscoveryRun} from '../sourcing/prospectPhoneDiscoveryStore.ts';
import {phoneDiscoveryAdmin,phoneDiscoveryNow} from '../sourcing/prospectPhoneDiscoveryAuthority.ts';
import {readManualProspectSubject} from '../sourcing/manualProspectRows.ts';
import {projectManualProspect} from '../sourcing/manualProspectProjection.ts';
import {projectManualPhoneChoice} from '../sourcing/manualProspectPhoneChoice.ts';
import {activeIdentityActor} from '../crm/identityAccess.ts';
import {readPreparedPhoneChoice} from '../sourcing/manualProspectPreparedPhone.ts';
import {preparedCaptureManifest} from '../sourcing/preparedCapture.ts';

export type PreparationRefusal='admin_only'|'candidate_unavailable'|'candidate_changed'|'choice_not_kept'|'choice_changed'|'source_withdrawn'|'creator_inactive'|'authority_changed'|'preparation_version_conflict'|'preparation_terminal'|'profile_invalid'|'duplicate_recorded_company'|'office_country_unresolved'|'firm_changed'|'route_changed';
export type PreparationResult<T>={ok:true;value:T}|{ok:false;reason:PreparationRefusal};
export type PreparationAuthority=()=>Promise<boolean>;
export type PreparationSourceKind='phone_discovery'|'prepared_capture';
export interface PreparationSource{
 selection:CallingPreparationSelection;
 /** `phone_discovery`: the discovery run. `prepared_capture` (ADR0034): the candidate's qualification run holding the chosen retained observation. */
 kind:PreparationSourceKind;runId:string;
 /** The discovery run's creator, or for a prepared capture the preparer whose admin authority stands behind it. */
 creatorUserId:string;
 phone:NonNullable<ReturnType<typeof projectManualPhoneChoice>>;
 profile:CallingPreparationProfile;sourceHashes:string[];
}
/** The stored preparation is bound to exactly this source, kind, run and authority holder. */
export function preparationSourceMatches(source:PreparationSource,p:{source_kind:string;discovery_run_ref:string;source_creator_ref:string}):boolean{
 return source.kind===p.source_kind&&source.runId===p.discovery_run_ref&&source.creatorUserId===p.source_creator_ref;
}
/** Internal current-source composition, also used for assigned-member execution.
 * Public source reads/confirmation separately enforce admin. Never impersonates
 * the creator, fetches, extends expiry or invalidates a run during a read/consume.
 */
export async function readPreparationSource(ctx:RepositoryContext,selection:CallingPreparationSelection,authority:PreparationAuthority,snapshot=false,preparedBy?:string):Promise<PreparationResult<PreparationSource>>{
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
 if(!row||!prospect)return {ok:false,reason:'source_withdrawn'};
 // A choice names a phone-discovery run, else the candidate's qualification run (prepared own-site pages, ADR0034).
 // Decided without a lock so the prepared path never takes discovery rows after qualification/evidence rows.
 const discovery=(await ctx.db.query('SELECT 1 FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2 AND candidate_id=$3',[ctx.scope.workspaceId,selection.choice.runId,selection.candidateId])).rows.length>0;
 if(!discovery)return readPreparedSource(ctx,selection,row,prospect,authority,snapshot,preparedBy);
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
 const sourceHashes=[...new Set(urls.map(hashUrl))].sort();
 return {ok:true,value:{selection,kind:'phone_discovery',runId:run.id,creatorUserId:run.creator_user_id,phone:finalPhone,sourceHashes,profile:preparationProfile(prospect)}};
}
type Prospect=NonNullable<ReturnType<typeof projectManualProspect>>;
const preparationProfile=(prospect:Prospect):CallingPreparationProfile=>({
 companyName:prospect.presentation?.label??prospect.observedName,
 website:prospect.website&&prospect.website.length<=500?prospect.website:null,addressLine:null,
 locality:prospect.locality&&prospect.locality.length<=120?prospect.locality:null,
 regionCode:prospect.region&&/^[A-Z]{2}$/u.test(prospect.region)?prospect.region:null,
 postalCode:null,countryCode:null,timeZone:{kind:'unknown'},
});
const hashUrl=(url:string)=>createHash('sha256').update(url.replace(/\/+$/u,'')).digest('hex');
/** ADR0034 prepared own-site source: the candidate's latest qualification run, read exactly as the prepared brief and
 * Calling literal choice read it, under the preparer's current admin authority. Never fetches, extends or writes. */
async function readPreparedSource(ctx:RepositoryContext,selection:CallingPreparationSelection,row:NonNullable<Awaited<ReturnType<typeof readManualProspectSubject>>>,prospect:Prospect,authority:PreparationAuthority,snapshot:boolean,preparedBy?:string):Promise<PreparationResult<PreparationSource>>{
 const preparer=preparedBy??(ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null);
 if(!preparer||!await phoneDiscoveryAdmin(ctx,preparer,!snapshot))return {ok:false,reason:'creator_inactive'};
 if(!await activeIdentityActor(ctx)||!await authority())return {ok:false,reason:'authority_changed'};
 const read=await readPreparedPhoneChoice(ctx,{...row,duplicate_count:0},selection.choice,authority,{principal:true,lockless:snapshot});
 if(!read.ok)return {ok:false,reason:'authority_changed'};
 if(!read.matched||!read.phone||!read.snapshot)return {ok:false,reason:'source_withdrawn'};
 if(!await authority()||!await activeIdentityActor(ctx)||!await phoneDiscoveryAdmin(ctx,preparer,!snapshot))return {ok:false,reason:'authority_changed'};
 // Every URL whose loss withdraws this company: candidate website and sources, the chosen page, and each capture hop.
 const urls=[prospect.website,...row.source_urls,read.phone.sourceUrl,...(preparedCaptureManifest(read.snapshot)?.pages.flatMap(page=>page.redirectUrls)??[])].filter((url):url is string=>!!url);
 const sourceHashes=[...new Set(urls.map(hashUrl))].sort();
 if(sourceHashes.length>23)return {ok:false,reason:'source_withdrawn'};
 return {ok:true,value:{selection,kind:'prepared_capture',runId:selection.choice.runId,creatorUserId:preparer,phone:read.phone,sourceHashes,profile:preparationProfile(prospect)}};
}
export function preparationSelection(candidateId:string,revision:number,choice:unknown):CallingPreparationSelection|null{
 const parsed=manualPhoneChoiceSchema.safeParse(choice);
 return parsed.success?{candidateId,expectedCandidateRevision:revision,choice:parsed.data}:null;
}
export const samePreparationChoice=(left:ManualPhoneChoice,right:ManualPhoneChoice)=>isDeepStrictEqual(left,right);
