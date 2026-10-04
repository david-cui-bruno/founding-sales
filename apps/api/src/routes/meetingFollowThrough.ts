import { meetingDraftEditCommandSchema,uuid } from '@fss/contracts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { lockAnalysisMeeting } from '@fss/domain/meetings/analysisRequests.ts';
import { readMeetingFollowThrough,editMeetingRecap } from '@fss/domain/meetings/followThrough.ts';
import { contextForPrincipal,requirePrincipal,runRouteCommand } from './routeSupport.ts';
import type { ApiRequest,RouteResult,RoutingOptions } from './types.ts';
export const MEETING_FOLLOW_THROUGH_PATHS: readonly string[]=['/meetings/follow-through','/meetings/recap/edit'];
export async function routeMeetingFollowThrough(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null> {
  if (!MEETING_FOLLOW_THROUGH_PATHS.includes(request.path)) return null;
  const missing={status:404,body:{error:'not_found'}},auth=options.auth;
  if(auth===undefined) return missing;
  if(request.method!==(request.path==='/meetings/follow-through'?'GET':'POST')) return {status:405,body:{error:'method_not_allowed'}};
  const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
  const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
  if(request.path==='/meetings/follow-through') {
    const id=uuid.safeParse(request.query.get('meetingId'));if(!id.success)return {status:400,body:{error:'invalid_input'}};
    const view=await readMeetingFollowThrough(scoped.context,{meetingId:id.data});return view===null?missing:{status:200,body:view};
  }
  type Receipt={meetingId:string;planId:string;version:number};
  const answer=await runRouteCommand<typeof meetingDraftEditCommandSchema,Receipt>({auth,request,principal:principal.principal},meetingDraftEditCommandSchema,'meeting_recap_edit',async(context,body)=>{
    const {commandId:_id,clientVersion:_client,...input}=body;
    const result=await editMeetingRecap(context,input);
    return result.ok?{ok:true,value:{meetingId:result.value.meetingId,planId:result.value.planId!,version:result.value.version}}:result;
  });
  if(answer.status!==200)return answer;
  const envelope=answer.body as {status:string;replayed:boolean;result:Receipt};
  // Receipts contain IDs only; every replay rechecks current visibility and version.
  return await withTransaction(auth.db,async()=>{
    const receipt=envelope.result;if(await lockAnalysisMeeting(scoped.context,receipt.meetingId)===null)return missing;
    const view=await readMeetingFollowThrough(scoped.context,{meetingId:receipt.meetingId});if(view===null)return missing;
    if(view.planId!==receipt.planId||view.version!==receipt.version)return {status:409,body:{status:'refused',reason:'draft_changed'}};
    return {status:200,body:{...envelope,result:view}};
  });
}
