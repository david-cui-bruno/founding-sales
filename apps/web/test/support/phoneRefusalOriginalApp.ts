import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {phoneDiscoveryCase,requirePhoneDiscoveryRuntimeGrant,seedPhoneDiscoveryCandidate,startPhoneDiscoveryApp} from './phoneDiscoveryApp.ts';
import {PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH} from '@fss/contracts';

export function isRefusalOriginalRequest(raw:string,origin:string):boolean{
 const url=new URL(raw,origin);return url.origin===origin&&url.pathname===`/browser/api${PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH}`;
}
export function refusalTransportEvent(event:string,ordinal:number,values:Record<string,number|boolean|string>={}):void{
 console.log('PHONE_REFUSAL_TRANSPORT',JSON.stringify({event,ordinal,at:performance.now(),...values}));
}
function observeServerTransport(origin:string):()=>void{
 let ordinal=0;
 const observe=(message:unknown)=>{
  const {request,response}=message as {request:IncomingMessage;response:ServerResponse};
  if(request.headers.host!==new URL(origin).host||!isRefusalOriginalRequest(request.url??'/',origin))return;
  const n=++ordinal,socket=response.socket,before=socket?.bytesWritten??0;
  refusalTransportEvent('server_request',n);
  const state=()=>({status:response.statusCode,destroyed:response.destroyed,writableFinished:response.writableFinished,contentLength:Number(response.getHeader('content-length')??0),socketBytes:Math.max(0,(socket?.bytesWritten??before)-before)});
  response.once('finish',()=>refusalTransportEvent('server_finish',n,state()));
  response.once('close',()=>refusalTransportEvent('server_close',n,state()));
 };
 subscribe('http.server.request.start',observe);
 return ()=>unsubscribe('http.server.request.start',observe);
}

export const refusalOriginalText='🏡 PHONE: <script>literal markup only</script> Ask our office. WHOLE RETAINED TAIL';
/** Fixture storage only. No capture request, worker, provider or acquisition. */
export async function startPhoneRefusalOriginalApp(){
 assert.equal(process.env['FSS_PHONE_REFUSAL_ORIGINAL_RUNTIME_GRANT'],'retained-only','Fresh Root selected-original runtime allocation required');
 requirePhoneDiscoveryRuntimeGrant();
 const owned=await startPhoneDiscoveryApp();
 const unobserve=observeServerTransport(owned.app.origin);
 try{
  const candidate=await seedPhoneDiscoveryCandidate(owned.app),db=owned.app.fixture.db,runId=randomUUID(),observationId=randomUUID();
  const w=owned.app.fixture.alpha.workspaceId,user=owned.app.fixture.alpha.admin.userId;
  const requested=(await db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
  const content={website:phoneDiscoveryCase.website,sourceUrls:[phoneDiscoveryCase.sourceUrl],observations:[]};
  await db.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,requested_at,deadline_at,expires_at,content)
   VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1','pending',$5,$5::timestamptz+interval '30 minutes',$5::timestamptz+interval '1 hour',$6::jsonb)`,[w,runId,candidate.candidateId,user,requested,JSON.stringify(content)]);
  await db.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[w,runId]);
  const blocks=[{id:'selected-whole',text:refusalOriginalText}],retrievedAt=(await db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  const observation={id:observationId,url:phoneDiscoveryCase.phoneUrl,contentHash:createHash('sha256').update(refusalOriginalText).digest('hex'),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
  await db.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$3::jsonb WHERE workspace_id=$1 AND id=$2",[w,runId,JSON.stringify({...content,observations:[observation]})]);
  return {...owned,candidate,runId,observationId,retrievedAt,stop:async()=>{try{await owned.stop();}finally{unobserve();}}};
 }catch(error){try{await owned.stop();}finally{unobserve();}throw error;}
}
