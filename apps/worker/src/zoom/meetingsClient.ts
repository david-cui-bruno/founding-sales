import type { ProviderRead, ZoomMeetingSnapshot, ZoomMeetingsClient, ZoomWriteResult } from '@fss/domain/meetings/autoRecordingTypes.ts';
import { attendeeAddressOf } from '@fss/domain/meetings/attendee.ts';
import { boundedProviderRequest, readFailure, record, type ProviderHttp } from '../providers/boundedHttp.ts';
const validId=(id:string)=>/^\d{9,11}$/u.test(id);
const refused=(code:string):{kind:'refused';code:string;retryAfterMs:null}=>({kind:'refused',code,retryAfterMs:null});
export function zoomMeetingsClient(options:{accountId:string;clientId:string;clientSecret:string;http?:ProviderHttp;now?:()=>number}):ZoomMeetingsClient {
  const http=options.http??fetch,now=options.now??Date.now;
  let token:string|null=null,expiresAt=0;
  async function authorize(signal:AbortSignal):Promise<ProviderRead<string>> {
    if(token!==null&&expiresAt-now()>60000)return {kind:'ok',value:token};
    const url=new URL('https://zoom.us/oauth/token');url.searchParams.set('grant_type','account_credentials');url.searchParams.set('account_id',options.accountId);
    const result=await boundedProviderRequest(http,url.toString(),{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${options.clientId}:${options.clientSecret}`).toString('base64')}`}},signal,10000);
    if(result.status!==200)return readFailure(result.status,result.retryAfterMs);
    const body=record(result.body);
    if(typeof body['access_token']!=='string'||!body['access_token']||typeof body['expires_in']!=='number'||!Number.isFinite(body['expires_in'])||body['expires_in']<=60)return refused('auth_failed');
    token=body['access_token'];expiresAt=now()+body['expires_in']*1000;return {kind:'ok',value:token};
  }
  return {
    async readMeeting(id,signal) {
      if(!validId(id))return refused('zoom_mismatch');
      try {
        for(let attempt=0;attempt<2;attempt++){
          const auth=await authorize(signal);if(auth.kind!=='ok')return auth;
          const result=await boundedProviderRequest(http,`https://api.zoom.us/v2/meetings/${id}`,{method:'GET',headers:{authorization:`Bearer ${auth.value}`}},signal,10000);
          if(result.status===401&&attempt===0){token=null;continue;}
          if(result.status!==200)return readFailure(result.status,result.retryAfterMs);
          const b=record(result.body),s=record(b['settings']),hostEmail=attendeeAddressOf(b['host_email']);
          const readId=typeof b['id']==='number'&&Number.isSafeInteger(b['id'])?String(b['id']):b['id'];
          if(readId!==id||hostEmail===null||typeof b['type']!=='number'||typeof b['start_time']!=='string'||!Number.isFinite(Date.parse(b['start_time']))||typeof b['duration']!=='number'||!Number.isInteger(b['duration']))return refused('zoom_mismatch');
          const value:ZoomMeetingSnapshot={id,hostEmail,type:b['type'],usePmi:typeof s['use_pmi']==='boolean'?s['use_pmi']:null,startsAt:new Date(b['start_time']).toISOString(),durationMinutes:b['duration'],autoRecording:typeof s['auto_recording']==='string'?s['auto_recording']:'unknown'};
          return {kind:'ok',value};
        }
        return refused('auth_failed');
      } catch {return {kind:'retry',code:'provider_unreachable',retryAfterMs:null};}
    },
    async setLocalAutoRecording(id,signal):Promise<ZoomWriteResult> {
      if(!validId(id))return refused('zoom_mismatch');
      if(token===null||expiresAt-now()<=60000)return refused('token_expired');
      if(signal.aborted)return refused('provider_unreachable');
      try {
        const result=await boundedProviderRequest(http,`https://api.zoom.us/v2/meetings/${id}`,{method:'PATCH',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({settings:{auto_recording:'local'}})},signal,5000);
        if(result.status===204)return {kind:'acknowledged',code:null,retryAfterMs:null};
        if(result.status>=500||result.status<400)return {kind:'unknown',code:'ambiguous_write',retryAfterMs:result.retryAfterMs};
        const failure=readFailure(result.status,result.retryAfterMs);return {kind:'refused',code:failure.code,retryAfterMs:failure.retryAfterMs};
      } catch {return {kind:'unknown',code:'ambiguous_write',retryAfterMs:null};}
    },
  };
}
export function readZoomMeetingsConfiguration(environment:Readonly<Record<string,string|undefined>>):{client:ZoomMeetingsClient;problem:null}|{client:null;problem:string} {
  const raw=environment['zoom-meetings'];if(!raw)return {client:null,problem:'absent'};
  let fields:Record<string,unknown>;try{fields=record(JSON.parse(raw));}catch{return {client:null,problem:'not_json'};}
  for(const field of ['account_id','client_id','client_secret'])if(typeof fields[field]!=='string'||!(fields[field] as string).trim())return {client:null,problem:`field:${field}`};
  return {client:zoomMeetingsClient({accountId:String(fields['account_id']).trim(),clientId:String(fields['client_id']).trim(),clientSecret:String(fields['client_secret']).trim()}),problem:null};
}
