import { retryMeetingRecordingSetupCommandSchema,uuid } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { readMeetingRecordingSetup,retryMeetingRecordingSetup } from '@fss/domain/meetings/autoRecording.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const MEETING_AUTO_RECORDING_PATHS:readonly string[]=['/meetings/recording-setup','/meetings/recording-setup/retry'];
export async function routeMeetingAutoRecording(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null> {
  if(!MEETING_AUTO_RECORDING_PATHS.includes(request.path))return null;
  const missing={status:404,body:{error:'not_found'}},auth=options.auth;if(!auth)return missing;
  if(request.method!==(request.path==='/meetings/recording-setup'?'GET':'POST'))return {status:405,body:{error:'method_not_allowed'}};
  const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
  const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
  if(request.method==='GET'){
    const id=uuid.safeParse(request.query.get('meetingId'));if(!id.success)return {status:400,body:{error:'invalid_input'}};
    return await withTransaction(auth.db,async()=>{const view=await readMeetingRecordingSetup(scoped.context,{meetingId:id.data});return view===null?missing:{status:200,body:view};});
  }
  type Receipt={meetingId:string;operationId:string;version:number};
  const answer=await runRouteCommand<typeof retryMeetingRecordingSetupCommandSchema,Receipt>({auth,request,principal:principal.principal},retryMeetingRecordingSetupCommandSchema,'meeting_recording_retry',async(context,body)=>{
    const at=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
    const result=await retryMeetingRecordingSetup(context,{meetingId:body.meetingId,expectedVersion:body.expectedVersion,at});
    return result.ok?{ok:true,value:{meetingId:result.value.meetingId,operationId:result.value.operationId!,version:result.value.version}}:result;
  });
  if(answer.status!==200)return answer;
  const envelope=answer.body as {status:string;replayed:boolean;result:Receipt};
  return await withTransaction(auth.db,async()=>{
    const view=await readMeetingRecordingSetup(scoped.context,{meetingId:envelope.result.meetingId});if(view===null)return missing;
    if(view.operationId!==envelope.result.operationId||view.version!==envelope.result.version)return {status:409,body:{status:'refused',reason:'recording_setup_changed'}};
    return {status:200,body:{...envelope,result:view}};
  });
}
