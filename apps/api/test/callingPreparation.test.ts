import {randomUUID,randomBytes} from 'node:crypto';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {CALLING_PREPARATION_COMMAND_KIND,type SessionGrant} from '@fss/contracts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {callingPreparationSources} from '@fss/domain/test/calling/preparationFixture.ts';
import {recordManualProspectFeedback} from '@fss/domain/sourcing/manualProspects.ts';
import {confirmCallingPreparation} from '@fss/domain/calling/preparation.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {lockPreparationCleanup} from '@fss/domain/calling/preparationLifecycle.ts';
import {dispatch} from '../src/server.ts';
import {localNoopSuppressionJournal} from '../src/journal/index.ts';
import {payloadHashOf} from '../src/auth/tokens.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {createBrowserHandler} from '../../web/src/server/browser.ts';
import {COOKIE_NAMES,sealCookie} from '../../web/src/server/cookies.ts';
let f:AuthFixture,runtime:SessionQueryable,source:ReturnType<typeof callingPreparationSources>,admin:SessionGrant,sales:SessionGrant,beta:SessionGrant;
const effects=vi.fn(()=>{throw Error('Preparation cannot call a provider');});
const twilio={accountSid:'FICTIONAL',twimlAppSid:'FICTIONAL',callerIdE164:'+14015550100',verifySignature:effects,mintAccessToken:effects,fetchRecording:effects};
const options=(db=runtime)=>({session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://example.test/update',suppressionJournal:localNoopSuppressionJournal(),integrations:{publicOrigin:null,twilio,calcom:null}});
const request=(path:'read'|'confirm'|'receipt',body:unknown,grant=admin,db=runtime,method='POST')=>dispatch({method,path:`/calling/preparation/${path}`,query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body},options(db));
const command=(input:Awaited<ReturnType<typeof source.source>>['input'])=>({...input,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const receipt=(input:ReturnType<typeof command>)=>{const {commandId,clientVersion:_version,...payload}=input;return {commandId,payloadSHA256:payloadHashOf(payload)};};
async function waiting(db:SessionQueryable){const pid=(await db.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;return ()=>expect.poll(async()=>Number((await f.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows[0]?.['n']),{timeout:3000}).toBe(1);}
beforeAll(async()=>{f=await createAuthFixture();runtime=await f.database.appRuntimeSession();source=callingPreparationSources(runtime,f);admin=await issueSessionFor(f,f.alpha,f.alpha.admin);sales=await issueSessionFor(f,f.alpha,f.alpha.salesperson);beta=await issueSessionFor(f,f.beta,f.beta.admin);});
afterAll(async()=>f?.stop());
it('registers only three closed POST routes, enforces admin, confirmed US and no acquisition/call/budget edits',async()=>{
 const s=await source.source(),input=command(s.input);
 expect((await request('read',s.input.selection,admin,runtime,'GET')).status).toBe(405);
 expect((await request('read',{...s.input.selection,phone:'+14015550123'})).status).toBe(400);
 expect((await request('read',s.input.selection,sales)).status).toBe(403);
 expect((await request('confirm',input,sales)).status).toBe(403);
 expect((await request('confirm',{...input,reviewedProfile:{...input.reviewedProfile,countryCode:null}})).status).toBe(400);
 expect((await request('read',s.input.selection)).body).toMatchObject({state:'available',binding:null,qualification:'unverified',contactAuthority:'not_granted'});
 const result=await request('confirm',input);expect(result.body).toMatchObject({status:'accepted',replayed:false,result:{historicalState:'prepared'}});
 for(const table of ['jobs','provider_reservations','call_sessions','contacts','opportunities','sequence_enrollments','workspace_settings'])expect((await runtime.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[f.alpha.workspaceId])).rows).toEqual([]);
 expect(effects).not.toHaveBeenCalled();
});
it('original user/device/kind/hash receipt is historical, terminal sources never regain a current view or reminted duplicate',async()=>{
 const s=await source.source(),input=command(s.input),result=await request('confirm',input);
 expect(result.body).toMatchObject({status:'accepted'});
 const p=(await runtime.query<{id:string}>('SELECT id FROM calling_preparations WHERE candidate_ref=$1',[s.input.selection.candidateId])).rows[0]!;
 await source.tx(async()=>{await lockPreparationCleanup(source.ctx());await runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[f.alpha.workspaceId,p.id]);});
 expect((await request('receipt',receipt(input))).body).toMatchObject({state:'accepted',result:{historicalState:'prepared'}});
 expect((await request('confirm',input)).body).toMatchObject({status:'accepted',replayed:true});
 expect((await request('read',s.input.selection)).body).toEqual({state:'withdrawn',preparationId:p.id,revision:2,reason:'source_withdrawn'});
 expect((await request('confirm',command(s.input))).body).toMatchObject({status:'refused',reason:'preparation_terminal'});
 const other=await issueSessionFor(f,f.alpha,f.alpha.admin);
 expect((await request('receipt',receipt(input),other)).body).toEqual({state:'unknown'});
 expect((await request('receipt',receipt(input),beta)).body).toEqual({state:'unknown'});
 expect((await request('receipt',{...receipt(input),payloadSHA256:'b'.repeat(64)})).body).toEqual({state:'unknown'});
 expect((await request('confirm',{...input,reviewedProfile:{...input.reviewedProfile,companyName:'Different'}})).body).toMatchObject({status:'refused',reason:'command_payload_mismatch'});
 expect((await runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE candidate_ref=$1',[s.input.selection.candidateId])).rows).toEqual([{n:1}]);
});
it('a receipt-uniqueness wait crossing current session authority rolls back company, route, hold, audit and receipt',async()=>{
 const s=await source.source(),input=command(s.input),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),wait=await waiting(worker),prior=f.deps.now();
 await blocker.query('BEGIN');await blocker.query("INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,$4,$5,'refused','\"fixture\"'::jsonb)",[f.alpha.workspaceId,grant.deviceId,input.commandId,CALLING_PREPARATION_COMMAND_KIND,'c'.repeat(64)]);
 const pending=request('confirm',input,grant,worker);
 try{await wait();f.advance(3600001);}finally{await blocker.query('ROLLBACK');}
 try{expect((await pending).status).toBe(401);}finally{f.setNow(prior);}
 expect((await runtime.query('SELECT 1 FROM calling_preparations WHERE candidate_ref=$1',[s.input.selection.candidateId])).rows).toEqual([]);
 expect((await runtime.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[input.commandId])).rows).toEqual([]);
 expect((await runtime.query('SELECT 1 FROM firms WHERE website=$1',[s.raw.website])).rows).toEqual([]);
});
it('read final principal wait crossing source expiry refuses all phone/profile bytes',async()=>{
 const s=await source.prepared(),worker=await f.database.appRuntimeSession(),grant=await issueSessionFor(f,f.alpha,f.alpha.admin);
 let authCount=0;const probe:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){if(sql.includes('FROM sessions'))authCount++;return worker.query<Row>(sql,values);}};await request('read',s.input.selection,grant,probe);
 await source.tx(async()=>{await lockPreparationCleanup(source.ctx());await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",[s.runId]);});
 // Delay the actual final authentication statement, after the domain projection
 // has completed. No product/test hook or fake source/lock is installed.
 let seen=0,delayed=false;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(text:string,values?:readonly unknown[]){
  if(text.includes('FROM sessions')&&++seen===authCount&&!delayed){delayed=true;await expect.poll(async()=>Number((await runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE id=$1 AND source_expires_at<=clock_timestamp()',[s.preparationId])).rows[0]?.['n'])).toBe(1);}
  return worker.query<Row>(text,values);
 }};
 const answer=await request('read',s.input.selection,grant,wrapped);
 expect(delayed).toBe(true);
 expect(answer.body).not.toHaveProperty('phone');expect(answer.body).not.toHaveProperty('profile');
 expect(answer.status===409||JSON.stringify(answer.body).includes('withdrawn')).toBe(true);
});

it('generic company API and browser reads mask expired source details before sweep; gateway final auth wait cannot publish the earlier live profile',async()=>{
 const p=await source.prepared(),origin='https://preparation.example.test',key=randomBytes(32),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),worker=await f.database.appRuntimeSession();
 const cookie=`${COOKIE_NAMES.access}=${sealCookie(key,origin,COOKIE_NAMES.access,{kind:'access',token:grant.accessToken,csrf:'c'.repeat(43),expiresAt:grant.accessTokenExpiresAt})}`;
 let finalRead=false,delayed=false;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){
  if(sql.includes('SELECT id FROM firms')&&sql.includes('FOR SHARE'))finalRead=true;
  if(finalRead&&!delayed&&sql.includes('FROM sessions')){delayed=true;await expect.poll(async()=>Number((await runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE id=$1 AND source_expires_at<=clock_timestamp()',[p.preparationId])).rows[0]?.['n'])).toBe(1);}
  return worker.query<Row>(sql,values);
 }};
 const handler=createBrowserHandler({origin,cookieKey:key,clientVersion:CURRENT_CLIENT_VERSION,withRequest:work=>work({auth:{...f.deps,db:wrapped,config:{...f.deps.config,oidc:{...f.deps.config.oidc,redirectUri:origin+'/browser/callback'}}},api:options(wrapped)})});
 const session=await handler({method:'GET',path:'/browser/session',query:new URLSearchParams(),headers:{cookie},body:undefined});
 const revision=(session?.body as {revision:string}).revision;
 await source.tx(async()=>{await lockPreparationCleanup(source.ctx());await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[p.runId]);});
 const requestBody={firmId:p.firmId,pageVersion:2,include:['tasks','timeline']};
 const late=await handler({method:'POST',path:'/browser/api/crm/firm-page-v3',query:new URLSearchParams(),headers:{cookie,origin,'content-type':'application/json','x-callie-csrf':'c'.repeat(43),'x-callie-session':revision},body:requestBody});
 expect(delayed).toBe(true);expect(late?.status).toBe(409);expect(JSON.stringify(late?.body)).not.toContain(p.input.reviewedProfile.companyName);
 const api=await dispatch({method:'POST',path:'/crm/firm-page-v3',query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body:requestBody},options());
 expect(api).toMatchObject({status:200,body:{read:{firm:{name:'[source unavailable company]',website:null,addressLine:null,locality:null,phoneRoutes:[]}}}});
 const masked=await handler({method:'GET',path:'/browser/api/firms',query:new URLSearchParams(),headers:{cookie,'x-callie-session':revision},body:undefined});
 expect(masked?.status).toBe(200);expect(JSON.stringify(masked?.body)).not.toContain(p.input.reviewedProfile.companyName);
 expect((await runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live'}]);
});
it('registered Calling wrong_number receipt wait rolls back on authority loss; original replay/receipt remain history after source erasure without a second outcome',async()=>{
 const p=await source.prepared(),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),cmd={commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,kind:'firm',firmId:p.firmId,report:{outcome:'wrong_number',routeId:p.routeId,note:'Fictional independent actual call report',performedByUser:true}};
 const call=(g=grant,db=runtime)=>dispatch({method:'POST',path:'/calling/wrap',query:new URLSearchParams(),headers:{authorization:`Bearer ${g.accessToken}`},body:cmd},options(db));
 const blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),wait=await waiting(worker),prior=f.deps.now();
 await blocker.query('BEGIN');await blocker.query("INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'calling.wrap',$4,'refused','\"fixture\"'::jsonb)",[f.alpha.workspaceId,grant.deviceId,cmd.commandId,'d'.repeat(64)]);
 const pending=call(grant,worker);try{await wait();f.advance(3600001);}finally{await blocker.query('ROLLBACK');}
 try{expect((await pending).status).toBe(401);}finally{f.setNow(prior);}
 expect((await runtime.query('SELECT 1 FROM call_logs WHERE firm_id=$1',[p.firmId])).rows).toEqual([]);
 expect((await runtime.query('SELECT eligibility,version FROM phone_routes WHERE id=$1',[p.routeId])).rows).toEqual([{eligibility:'candidate',version:1}]);
 expect((await runtime.query('SELECT state,revision,route_version FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live',revision:1,route_version:1}]);
 expect((await call()).body).toMatchObject({status:'accepted',replayed:false});
 await source.tx(async()=>{await lockPreparationCleanup(source.ctx());await runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[f.alpha.workspaceId,p.preparationId]);});
 expect((await call()).body).toMatchObject({status:'accepted',replayed:true});
 const {commandId,clientVersion:_version,...payload}=cmd;
 const recovered=await dispatch({method:'POST',path:'/calling/follow-ups/receipt',query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body:{operation:'wrap',commandId,payloadSHA256:payloadHashOf(payload)}},options());
 expect(recovered.body).toMatchObject({state:'accepted',acceptance:{operation:'wrap'}});
 expect((await runtime.query('SELECT outcome,note FROM call_logs WHERE firm_id=$1',[p.firmId])).rows).toEqual([{outcome:'wrong_number',note:'Fictional independent actual call report'}]);
 expect((await runtime.query('SELECT e164,eligibility FROM phone_routes WHERE id=$1',[p.routeId])).rows).toEqual([{e164:null,eligibility:'retired'}]);
});

it('preparation read retains lifecycle through the exact final principal wait so choice withdrawal must serialize after publication',async()=>{
 const p=await source.prepared(),reader=await f.database.appRuntimeSession(),mutator=await f.database.appRuntimeSession(),wait=await waiting(mutator);
 let count=0;const probe:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){if(sql.includes('FROM sessions'))count++;return reader.query<Row>(sql,values);}};await request('read',p.input.selection,admin,probe);
 let held!:()=>void,release!:()=>void;const paused=new Promise<void>(yes=>{held=yes;}),resume=new Promise<void>(yes=>{release=yes;});let seen=0;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){if(sql.includes('FROM sessions')&&++seen===count){held();await resume;}return reader.query<Row>(sql,values);}};
 const reading=request('read',p.input.selection,admin,wrapped);await paused;
 const changing=withTransaction(mutator,()=>recordManualProspectFeedback(source.ctx(mutator),{candidateId:p.input.selection.candidateId,expectedRevision:1,state:'kept',phoneChoice:null}));
 try{await wait();}finally{release();}expect((await reading).body).toMatchObject({state:'available'});expect(await changing).toMatchObject({ok:true});
 expect((await request('read',p.input.selection)).body).toMatchObject({state:'withdrawn'});
});
it.each(['choice','profile'] as const)('generic gateway rejects old company bytes when %s changes during its final principal wait',async mutation=>{
 const p=await source.prepared(),origin='https://preparation.example.test',key=randomBytes(32),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),reader=await f.database.appRuntimeSession();
 const cookie=`${COOKIE_NAMES.access}=${sealCookie(key,origin,COOKIE_NAMES.access,{kind:'access',token:grant.accessToken,csrf:'c'.repeat(43),expiresAt:grant.accessTokenExpiresAt})}`;
 let armed=false,changed=false;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){
  if(armed&&!changed&&sql.includes('FROM sessions')){changed=true;
   if(mutation==='choice')expect(await source.tx(()=>recordManualProspectFeedback(source.ctx(),{candidateId:p.input.selection.candidateId,expectedRevision:1,state:'kept',phoneChoice:null}))).toMatchObject({ok:true});
   else expect(await source.tx(()=>confirmCallingPreparation(source.ctx(),{...p.input,expected:{state:'live',preparationId:p.preparationId,revision:1,routeVersion:1},reviewedProfile:{...p.input.reviewedProfile,companyName:'New explicit source-reviewed label'}},async()=>true))).toMatchObject({ok:true});
  }
  const result=await reader.query<Row>(sql,values);if(sql.includes('calling_preparation_profile_hash'))armed=true;return result;
 }};
 const handler=createBrowserHandler({origin,cookieKey:key,clientVersion:CURRENT_CLIENT_VERSION,withRequest:work=>work({auth:{...f.deps,db:wrapped,config:{...f.deps.config,oidc:{...f.deps.config.oidc,redirectUri:origin+'/browser/callback'}}},api:options(wrapped)})});
 const session=await handler({method:'GET',path:'/browser/session',query:new URLSearchParams(),headers:{cookie},body:undefined});
 const result=await handler({method:'GET',path:'/browser/api/firms',query:new URLSearchParams(),headers:{cookie,'x-callie-session':(session?.body as {revision:string}).revision},body:undefined});
 expect(changed).toBe(true);expect(result?.status).toBe(409);expect(JSON.stringify(result?.body)).not.toContain(p.input.reviewedProfile.companyName);
});
it('confirm captures the original principal deadline and rolls back when a later exact source-read wait crosses it',async()=>{
 const s=await source.source(),input=command(s.input),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),worker=await f.database.appRuntimeSession(),prior=f.deps.now();let captured=false,delayed=false;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){
  const result=await worker.query<Row>(sql,values);
  if(sql.includes('SELECT expires_at,reauthenticate_after FROM sessions'))captured=true;
  else if(captured&&!delayed&&sql.includes('calling_preparation_profile_hash')){delayed=true;await Promise.resolve();f.advance(3600001);}
  return result;
 }};
 try{expect((await request('confirm',input,grant,wrapped)).status).toBe(401);expect(delayed).toBe(true);}finally{f.setNow(prior);}
 expect((await runtime.query('SELECT 1 FROM calling_preparations WHERE candidate_ref=$1',[s.input.selection.candidateId])).rows).toEqual([]);expect((await runtime.query('SELECT 1 FROM command_receipts WHERE command_id=$1',[input.commandId])).rows).toEqual([]);
});
it('generic source deadline is explicit opt-in, clipped/current and absent from legacy/independent DTOs',async()=>{
 const p=await source.prepared();
 const get=(include:boolean)=>dispatch({method:'GET',path:'/firms',query:new URLSearchParams(include?'include=callingPreparation':''),headers:{authorization:`Bearer ${admin.accessToken}`},body:undefined},options());
 const old=await get(false),live=await get(true);expect(JSON.stringify(old.body)).not.toContain('callingPreparationExpiresAt');
 const row=(live.body as {firms:{id:string;callingPreparationExpiresAt?:string}[]}).firms.find(firm=>firm.id===p.firmId);expect(row?.callingPreparationExpiresAt).toBeTruthy();
 const page=await dispatch({method:'POST',path:'/crm/firm-page-v3',query:new URLSearchParams(),headers:{authorization:`Bearer ${admin.accessToken}`},body:{firmId:p.firmId,pageVersion:2,include:['callingPreparation']}},options());expect(page.body).toMatchObject({read:{firm:{callingPreparationExpiresAt:row?.callingPreparationExpiresAt}}});
 await source.tx(async()=>{await lockPreparationCleanup(source.ctx());await runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[f.alpha.workspaceId,p.preparationId]);});
 const erased=await get(true);expect((erased.body as {firms:{id:string;name:string;callingPreparationExpiresAt?:string}[]}).firms.find(firm=>firm.id===p.firmId)).toMatchObject({name:'[source unavailable company]'});expect((erased.body as {firms:{id:string;callingPreparationExpiresAt?:string}[]}).firms.find(firm=>firm.id===p.firmId)).not.toHaveProperty('callingPreparationExpiresAt');
});

it.each((['prepared','independent'] as const).flatMap(company=>(['device','session'] as const).map(revoked=>({company,revoked}))))('generic $company publication rechecks original $revoked after a real final lifecycle wait',async({company,revoked})=>{
 const {createFirm}=await import('@fss/domain/crm/firms.ts');
 const label='Independent final-publication company';let firmId:string;
 if(company==='prepared')firmId=(await source.prepared()).firmId;
 else {const saved=await source.tx(()=>createFirm(source.ctx(),{name:label,countryCode:'US'}));if(!saved.ok)throw Error(saved.reason);firmId=saved.value.id;}
 const origin='https://preparation.example.test',key=randomBytes(32),grant=await issueSessionFor(f,f.alpha,f.alpha.admin),reader=await f.database.appRuntimeSession(),blocker=await f.database.appRuntimeSession(),wait=await waiting(reader);
 const cookie=`${COOKIE_NAMES.access}=${sealCookie(key,origin,COOKIE_NAMES.access,{kind:'access',token:grant.accessToken,csrf:'c'.repeat(43),expiresAt:grant.accessTokenExpiresAt})}`;
 const handler=createBrowserHandler({origin,cookieKey:key,clientVersion:CURRENT_CLIENT_VERSION,withRequest:work=>work({auth:{...f.deps,db:reader,config:{...f.deps.config,oidc:{...f.deps.config.oidc,redirectUri:origin+'/browser/callback'}}},api:options(reader)})});
 const session=await handler({method:'GET',path:'/browser/session',query:new URLSearchParams(),headers:{cookie},body:undefined});
 await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${f.alpha.workspaceId}`]);
 const pending=handler({method:'GET',path:'/browser/api/firms/'+firmId,query:new URLSearchParams(),headers:{cookie,'x-callie-session':(session?.body as {revision:string}).revision},body:undefined});
 try{await wait();if(revoked==='device')await f.db.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[f.alpha.workspaceId,grant.deviceId]);
 else await f.db.query("UPDATE sessions SET status='ended',ended_at=clock_timestamp(),end_reason='signed_out' WHERE workspace_id=$1 AND device_id=$2",[f.alpha.workspaceId,grant.deviceId]);
 }finally{await blocker.query('COMMIT');}
 const result=await pending;expect(result?.status).toBe(409);expect(JSON.stringify(result?.body)).not.toContain(label);expect(result?.body).toEqual({error:'browser_request_refused'});
});

it.each(['firm-page','firm'] as const)('generic independent %s detail refuses reassignment during final lifecycle wait',async view=>{
 const {createFirm}=await import('@fss/domain/crm/firms.ts');const saved=await source.tx(()=>createFirm(source.ctx(),{name:'Private assigned source-independent company',countryCode:'US',assignedUserId:f.alpha.salesperson.userId}));if(!saved.ok)throw Error(saved.reason);
 const origin='https://preparation.example.test',key=randomBytes(32),grant=await issueSessionFor(f,f.alpha,f.alpha.salesperson),reader=await f.database.appRuntimeSession(),blocker=await f.database.appRuntimeSession(),wait=await waiting(reader);
 const cookie=`${COOKIE_NAMES.access}=${sealCookie(key,origin,COOKIE_NAMES.access,{kind:'access',token:grant.accessToken,csrf:'c'.repeat(43),expiresAt:grant.accessTokenExpiresAt})}`;
 const handler=createBrowserHandler({origin,cookieKey:key,clientVersion:CURRENT_CLIENT_VERSION,withRequest:work=>work({auth:{...f.deps,db:reader,config:{...f.deps.config,oidc:{...f.deps.config.oidc,redirectUri:origin+'/browser/callback'}}},api:options(reader)})});
 const session=await handler({method:'GET',path:'/browser/session',query:new URLSearchParams(),headers:{cookie},body:undefined});
 await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${f.alpha.workspaceId}`]);
 const pending=handler({method:view==='firm-page'?'POST':'GET',path:'/browser/api/'+(view==='firm-page'?'crm/firm-page-v3':'firms/'+saved.value.id),query:new URLSearchParams(),headers:{cookie,origin,'content-type':'application/json','x-callie-csrf':'c'.repeat(43),'x-callie-session':(session?.body as {revision:string}).revision},body:view==='firm-page'?{firmId:saved.value.id,pageVersion:2}:undefined});
 try{await wait();await runtime.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1',[saved.value.id,f.alpha.admin.userId]);}finally{await blocker.query('COMMIT');}
 const result=await pending;expect(result?.status).toBe(409);expect(JSON.stringify(result?.body)).not.toContain('Private assigned source-independent company');
});
