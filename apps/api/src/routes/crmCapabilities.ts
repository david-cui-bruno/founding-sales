import {crmCapabilityActivateSchema,crmCapabilityDisableSchema,crmCapabilityReadSchema,crmCapabilityReadResponseSchema,crmMailCaptureControlsSaveSchema,crmAskPurposeSaveSchema,type CrmCapabilityConfiguration} from '@fss/contracts';
import {activateCrmCapability,disableCrmCapability,readCrmCapability,saveCrmMailCaptureControls,saveCrmAskPurpose} from '@fss/domain/crm/capabilityAuthority.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import {redactError} from '../limits.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';

const routes = {
 '/crm/business/policy/activate': {action:'activate',capability:'metadata_review'},
 '/crm/business/policy/disable': {action:'disable',capability:'metadata_review'},
 '/crm/business/mail/controls/save': {action:'mail_save',capability:'mail_capture'},
 '/crm/business/mail/controls/activate': {action:'activate',capability:'mail_capture'},
 '/crm/business/mail/controls/disable': {action:'disable',capability:'mail_capture'},
 '/crm/processing/purpose/activate': {action:'activate',capability:'crm_extraction'},
 '/crm/processing/purpose/disable': {action:'disable',capability:'crm_extraction'},
 '/ask/purpose/read': {action:'read',capability:'ask_answer'},
 '/ask/purpose/save': {action:'ask_save',capability:'ask_answer'},
 '/ask/purpose/activate': {action:'activate',capability:'ask_answer'},
 '/ask/purpose/disable': {action:'disable',capability:'ask_answer'},
 '/crm/capability/read': {action:'read',capability:null},
} as const;
export const CRM_CAPABILITY_PATHS = Object.keys(routes);
function capabilityTarget(input:{capability:CrmCapabilityConfiguration['capability'];mailboxId?:string|undefined}){return {capability:input.capability,...input.mailboxId===undefined?{}:{mailboxId:input.mailboxId}};}
export async function routeCrmCapabilities(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!Object.hasOwn(routes,request.path))return null;
 const route=routes[request.path as keyof typeof routes];
 if(!options.auth)return {status:401,body:redactError('unauthenticated')};
 const verified=await requirePrincipal(options.auth,request);if(!verified.ok)return verified.result;
 const scoped=contextForPrincipal(options.auth,verified.principal);if(!scoped.ok)return scoped.result;
 if(request.method!=='POST')return {status:405,body:redactError('method_not_allowed')};
 if(route.action==='mail_save')return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmMailCaptureControlsSaveSchema,'crm.mail_capture_controls_saved',saveCrmMailCaptureControls);
 if(route.action==='ask_save')return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmAskPurposeSaveSchema,'crm.ask_purpose_saved',saveCrmAskPurpose);
 if(route.action==='activate')return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmCapabilityActivateSchema,'crm.capability_activated',(context,body)=>body.capability!==route.capability?Promise.resolve({ok:false,reason:'capability_path_mismatch'}):activateCrmCapability(context,{...capabilityTarget(body),expectedRevision:body.expectedRevision,authorityReceiptId:body.authorityReceiptId},options.crmCapabilityRuntime));
 if(route.action==='disable')return runRouteCommand({auth:options.auth,request,principal:verified.principal},crmCapabilityDisableSchema,'crm.capability_disabled',(context,body)=>body.capability!==route.capability?Promise.resolve({ok:false,reason:'capability_path_mismatch'}):disableCrmCapability(context,{...capabilityTarget(body),expectedRevision:body.expectedRevision}));
 const parsed=crmCapabilityReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:redactError('malformed_body')};
 if(route.capability!==null&&parsed.data.capability!==route.capability)return {status:400,body:redactError('malformed_body')};
 const result=await withTransaction(options.auth.db,()=>readCrmCapability(scoped.context,capabilityTarget(parsed.data),options.crmCapabilityRuntime));
 return result===null?{status:404,body:redactError('not_found')}:{status:200,body:crmCapabilityReadResponseSchema.parse(result)};
}
