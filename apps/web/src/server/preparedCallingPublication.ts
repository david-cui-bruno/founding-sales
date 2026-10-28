import {z} from 'zod';
import {requireCallingAuthority,CallingAuthorityChanged} from '@fss/domain/calling/followUpDraftAccess.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {lockDiscoveryReviewSources} from '@fss/domain/sourcing/discoveryReviewVisibility.ts';
import {readPreparedProjections,preparedProjectionUnavailable,SOURCE_UNAVAILABLE_COMPANY,type PreparedProjection} from '@fss/domain/calling/preparationProjection.ts';
import {privateFirmIsCurrent} from '../../../api/src/routes/privateReadAuthority.ts';
import {retainedPrincipalPublicationAuthority} from '../../../api/src/routes/retainedPrincipalAuthority.ts';
import {contextForPrincipal} from '../../../api/src/routes/routeSupport.ts';
import type {AuthenticatedPrincipal} from '../../../api/src/auth/sessions.ts';
import type {BrowserRequestContext} from './runtime.ts';
const firm=z.object({id:z.string().uuid(),name:z.string()}).passthrough();
const today=z.object({firmId:z.string().uuid(),firmName:z.string()}).passthrough();
type Subject={id:string;name:string;fields:Readonly<Record<string,unknown>>};
const subject=(f:z.infer<typeof firm>):Subject=>({id:f.id,name:f.name,fields:f});
/** Closed current views only. Final exact source/owned-field comparison runs AFTER
 * gateway auth waits, under lifecycle custody. The synchronous deadline predicate
 * runs after COMMIT, with no subsequent awaited boundary for these read paths.
 */
export async function preparedCallingPublication(context:BrowserRequestContext,principal:AuthenticatedPrincipal,path:string,body:unknown,token:string):Promise<()=>boolean>{
 let subjects:Subject[]=[];
 if(path==='/firms')subjects=z.object({firms:z.array(firm)}).parse(body).firms.map(subject);
 else if(/^\/firms\/[0-9a-f-]{36}$/iu.test(path))subjects=[subject(z.object({firm}).parse(body).firm)];
 else if(path==='/crm/firm-page-v3')subjects=[subject(z.object({read:z.object({firm})}).parse(body).read.firm)];
 else if(path==='/today')subjects=z.object({cards:z.array(today)}).parse(body).cards.map(p=>({id:p.firmId,name:p.firmName,fields:{callingPreparationExpiresAt:p['callingPreparationExpiresAt']}}));
 else if(path==='/today/firm'){const p=today.parse(body);subjects=[{id:p.firmId,name:p.firmName,fields:p}];}
 else if(path==='/today/actions/v3'||path==='/today/actions/v4'){
  const actions=z.object({actions:z.array(z.object({subject:z.string(),callingPreparationExpiresAt:z.string().optional(),target:z.object({kind:z.string(),firmId:z.string().uuid().optional()}),firms:z.array(firm).nullable().optional()}))}).parse(body).actions;
  subjects=actions.flatMap(a=>[...((a.target.kind==='reply'||a.target.kind==='meeting')&&a.target.firmId?[{id:a.target.firmId,name:a.subject,fields:{callingPreparationExpiresAt:a.callingPreparationExpiresAt}}]:[]),...(a.firms??[]).map(subject)]);
 }else return ()=>true;
 const detail=path==='/today'||path==='/today/firm'||path==='/crm/firm-page-v3'&&z.object({read:z.object({visibility:z.string()})}).parse(body).read.visibility==='assigned_or_admin'||/^\/firms\/[0-9a-f-]{36}$/iu.test(path)&&z.object({visibility:z.string()}).parse(body).visibility==='assigned_or_admin';
 const scoped=contextForPrincipal(context.auth,principal);if(!scoped.ok)return ()=>false;
 const publication=retainedPrincipalPublicationAuthority({auth:context.auth,principal,request:{method:'GET',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body:undefined}},scoped.context);
 const states=await withTransaction(context.auth.db,async()=>{
  await lockDiscoveryReviewSources(scoped.context);
  // Lifecycle may wait even for an independent company. Pin the original
  // device/session AFTER that wait, through source comparison and COMMIT.
  try{await requireCallingAuthority(scoped.context,publication.authority);}catch(error){if(error instanceof CallingAuthorityChanged)return null;throw error;}
  if(detail)for(const id of [...new Set(subjects.map(s=>s.id))].sort()){
   await scoped.context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE',[principal.workspaceId,id]);
   if(!await privateFirmIsCurrent(scoped.context,id))return null;
  }
  return readPreparedProjections(scoped.context,subjects.map(s=>s.id));
 });
 return ()=>states!==null&&publication.publicationNow(Date.now())!==null&&subjects.every(s=>matchesCurrent(s,states.get(s.id),preparedProjectionUnavailable(states,s.id)));
}
function matchesCurrent(subject:Subject,state:PreparedProjection|undefined,unavailable:boolean):boolean{
 if(!state)return true;
 const {fields}=subject;if(typeof fields['callingPreparationExpiresAt']==='string'&&(unavailable||Date.parse(fields['callingPreparationExpiresAt'])>state.expiresAt||Date.parse(fields['callingPreparationExpiresAt'])<=Date.now()))return false;
 const profile=unavailable?{name:SOURCE_UNAVAILABLE_COMPANY,website:null,addressLine:null,locality:null,regionCode:null,postalCode:null,countryCode:'ZZ',timeZone:null,timeZoneConfidence:null,timeZoneSource:null,timeZoneUnresolvedReason:null}:state.profile;
 if(!profile||subject.name!==profile['name']&&!(unavailable&&subject.name==='[deleted]'))return false;
 for(const [key,value] of Object.entries(profile))if(key!=='name'&&Object.hasOwn(fields,key)&&fields[key]!==value)return false;
 if(Object.hasOwn(fields,'phoneRoutes')){
  const routes=z.array(z.object({id:z.string(),value:z.string(),version:z.number()})).parse(fields['phoneRoutes']);
  if(unavailable?routes.length!==0:routes.length!==1||routes[0]?.id!==state.route?.id||routes[0]?.value!==state.route?.value||routes[0]?.version!==state.route?.version)return false;
 }
 if(Object.hasOwn(fields,'routes')){
  const routes=z.array(z.object({routeId:z.string(),e164:z.string(),version:z.number()})).parse(fields['routes']);
  if(routes.some(r=>unavailable||r.routeId!==state.route?.id||r.e164!==state.route?.value||r.version!==state.route?.version))return false;
 }
 if(Object.hasOwn(fields,'basics')){const basics=z.object({locality:z.string().nullable(),regionCode:z.string().nullable(),timeZone:z.string().nullable()}).parse(fields['basics']);for(const [key,value]of Object.entries(basics))if(profile[key]!==value)return false;}
 return true;
}
