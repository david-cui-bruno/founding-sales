import {saveMeetingQualificationCommandSchema,uuid} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {lockAnalysisMeeting} from '@fss/domain/meetings/analysisRequests.ts';
import {readMeetingQualification,saveMeetingQualification} from '@fss/domain/meetings/qualification.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const MEETING_QUALIFICATION_PATHS=['/meetings/qualification','/meetings/qualification/save'];
export async function routeMeetingQualification(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!MEETING_QUALIFICATION_PATHS.includes(request.path))return null;
 const missing={status:404,body:{error:'not_found'}},auth=options.auth;if(!auth)return missing;
 if(request.method!==(request.path==='/meetings/qualification'?'GET':'POST'))return {status:405,body:{error:'method_not_allowed'}};
 const authenticated=await requirePrincipal(auth,request);if(!authenticated.ok)return authenticated.result;
 const scoped=contextForPrincipal(auth,authenticated.principal);if(!scoped.ok)return scoped.result;
 if(request.path==='/meetings/qualification'){
  const parsed=uuid.safeParse(request.query.get('meetingId'));if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  return withTransaction(auth.db,async()=>{
   if(!await lockAnalysisMeeting(scoped.context,parsed.data))return missing;
   const view=await readMeetingQualification(scoped.context,parsed.data);return view?{status:200,body:view}:missing;
  });
 }
 const answer=await runRouteCommand({auth,request,principal:authenticated.principal},saveMeetingQualificationCommandSchema,'meeting_qualification_save',async(ctx,body)=>{
  const {clientVersion:_version,...input}=body;const result=await saveMeetingQualification(ctx,input);
  return result.ok?{ok:true as const,value:{meetingId:input.meetingId,revision:result.value.revision}}:result;
 });
 if(answer.status!==200)return answer;
 const envelope=answer.body as {status:string;replayed:boolean;result:{meetingId:string;revision:number}};
 return withTransaction(auth.db,async()=>{
  if(!await lockAnalysisMeeting(scoped.context,envelope.result.meetingId))return missing;
  const view=await readMeetingQualification(scoped.context,envelope.result.meetingId);if(!view)return missing;
  if(view.revision!==envelope.result.revision)return {status:409,body:{status:'refused',reason:'qualification_changed'}};
  return {status:200,body:{...envelope,result:view}};
 });
}
