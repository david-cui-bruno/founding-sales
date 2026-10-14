import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {expect,it} from 'vitest';
import type {BookingPolicyBindings} from '@fss/contracts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {readSettingHistory,updateSetting} from '@fss/domain/settings/store.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {dispatch} from '../src/server.ts';
import {authenticate} from '../src/auth/sessions.ts';
import {contextForPrincipal} from '../src/routes/routeSupport.ts';

const envelope=()=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
const policyPath='/meetings/booking-policy';
function bindings(ownerUserId:string):BookingPolicyBindings {
 return {ownerUserId,account:{provider:'calcom',accountId:'controlled-cal-account',email:'david@owner.example',generation:1},event:{eventTypeId:73,bookingUrl:'https://cal.com/controlled-owner/demo',configurationRevision:'event-observation-1'},calendars:[{credentialId:4,externalId:'owner-business'}],source:{scopeRevision:'booking-scope-1',dataScope:'necessary_booking_context_attendee_selected_freebusy',dataHandlingVersion:'minimized-booking-v1'},sender:{channel:'email',accountId:'controlled-sender',authorityRevision:'sender-1'},model:{providerKey:'aws_bedrock',route:'us.anthropic.claude-haiku-4-5-20251001-v1:0',modelVersion:'anthropic.claude-haiku-4-5-20251001-v1:0',accountBinding:'controlled-aws-us-east-1',consentRevision:'booking-model-consent-1',purpose:'booking_interpretation',qualityReviewRevision:null,selection:'initial_haiku'},budget:{lane:'booking',timeZone:'America/New_York',dailyCeilingCents:200,monthlyCeilingCents:2500}};
}
function caller(f:AuthFixture,token:string,db:SessionQueryable) {
 return (method:string,path:string,body?:unknown)=>dispatch({method,path,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`},body},{session:db,auth:{...f.deps,db},supportedClientVersions:f.deps.config.supportedClientVersions,sendingEnabled:false,upgradeUrl:'https://fixture.invalid/update'});
}
async function setup(){
 const f=await createAuthFixture();
 const owner=await issueSessionFor(f,f.alpha,f.alpha.admin,{deviceLabel:'policy owner'});
 const observer=await issueSessionFor(f,f.alpha,f.alpha.admin,{deviceLabel:'policy observer'});
 const db=await f.database.appRuntimeSession(),observerDb=await f.database.appRuntimeSession();
 return {f,owner,db,call:caller(f,owner.accessToken,db),observe:caller(f,observer.accessToken,observerDb),binding:bindings(f.alpha.admin.userId)};
}
async function pid(db:SessionQueryable){return (await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;}
/** SQL observes/synchronizes real waits only. Policy and identity changes use mounted public routes. */
async function blocked(db:SessionQueryable,waiting:number,blocking:number){
 for(let n=0;n<200;n++){
  if((await db.query<{blocked:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) AS blocked',[waiting,blocking])).rows[0]?.blocked)return;
  await delay(5);
 }
 throw new Error('Public booking policy command did not reach the real settings advisory lock');
}
it('generic settings update cannot restore saved booking scope after a dedicated revoke',async()=>{
 const {f,call,binding,owner,db}=await setup();try{
 expect((await call('GET',policyPath)).body).toMatchObject({revision:0,setting:{status:'disabled',enabled:false,bindings:null}});
 const save={...envelope(),action:'save',expectedRevision:0,bindings:binding};
 expect((await call('POST',policyPath,save)).body).toMatchObject({result:{revision:1}});
 const saved=await call('GET',policyPath);
 const setting=(saved.body as {setting:unknown}).setting;
 expect((await call('POST',policyPath,{...envelope(),action:'revoke',expectedRevision:1})).body).toMatchObject({result:{revision:2}});
 const stale=await call('POST','/settings/update',{...envelope(),settingKey:'booking_policy',value:setting});
 expect(stale.status).toBe(400);
 // The wire refusal is not the only guard: a generic domain caller also
 // cannot rewrite booking scope. Its context comes from the actual session.
 const authenticated=await authenticate({...f.deps,db},`Bearer ${owner.accessToken}`);
 if(!authenticated.authenticated)throw new Error('Owner session unavailable');
 const scoped=contextForPrincipal({...f.deps,db},authenticated.principal);
 if(!scoped.ok)throw new Error('Owner scope unavailable');
 expect(await withTransaction(db,()=>updateSetting(scoped.context,{settingKey:'booking_policy',value:setting}))).toEqual({ok:false,reason:'invalid_value'});
 expect((await readSettingHistory(scoped.context,'booking_policy')).map(row=>row.version)).toEqual([2,1]);
 expect((await call('GET',policyPath)).body).toMatchObject({revision:2,setting:{status:'revoked'}});
 expect((await call('POST',policyPath,{...envelope(),action:'save',expectedRevision:1,bindings:binding})).body).toMatchObject({reason:'stale_revision'});
 // Historical dedicated receipts stay historical and cannot restore current state.
 expect((await call('POST',policyPath,save)).body).toMatchObject({replayed:true,result:{revision:1}});
 expect((await call('GET',policyPath)).body).toMatchObject({revision:2,setting:{status:'revoked'}});
 // Unrelated generic settings retain their ordinary mutation contract.
 expect((await call('POST','/settings/update',{...envelope(),settingKey:'postal_address',value:{address:'Controlled owner office'}})).status).toBe(200);
 }finally{await f.stop();}
});
it('mounted dedicated saves disable revoke and revision collisions preserve immutable replay without generic mutation',async()=>{
 const {f,call,observe,binding}=await setup();try{
 const save={...envelope(),action:'save',expectedRevision:0,bindings:binding};
 expect((await call('POST',policyPath,save)).body).toMatchObject({result:{revision:1}});
 const disable={...envelope(),action:'disable',expectedRevision:1};
 expect((await call('POST',policyPath,disable)).body).toMatchObject({result:{revision:2}});
 expect((await call('POST',policyPath,disable)).body).toMatchObject({replayed:true,result:{revision:2}});
 expect((await call('GET',policyPath)).body).toMatchObject({revision:2,setting:{status:'disabled'}});
 const collisions=await Promise.all([
  call('POST',policyPath,{...envelope(),action:'save',expectedRevision:2,bindings:binding}),
  observe('POST',policyPath,{...envelope(),action:'save',expectedRevision:2,bindings:binding}),
 ]);
 expect(collisions.map(result=>result.status).sort()).toEqual([200,409]);
 expect(collisions.find(result=>result.status===409)?.body).toMatchObject({reason:'stale_revision'});
 const revoke={...envelope(),action:'revoke',expectedRevision:3};
 expect((await call('POST',policyPath,revoke)).body).toMatchObject({result:{revision:4}});
 expect((await call('POST',policyPath,revoke)).body).toMatchObject({replayed:true,result:{revision:4}});
 expect((await call('POST',policyPath,{...revoke,action:'disable'})).body).toMatchObject({reason:'command_payload_mismatch'});
 expect((await call('POST',policyPath,save)).body).toMatchObject({replayed:true,result:{revision:1}});
 expect((await call('GET',policyPath)).body).toMatchObject({revision:4,setting:{status:'revoked'},enabled:false});
 }finally{await f.stop();}
});
it.each(['save','disable','revoke'].flatMap(action=>['sign-out','device-revoke'].map(loss=>({action,loss}))))('$action refuses mutation after $loss during the actual settings lock wait',async({action,loss})=>{
 const {f,owner,db,call,observe,binding}=await setup();
 const key=`${f.alpha.workspaceId}:booking_policy`;let pending:ReturnType<typeof call>|undefined;
 try{
 expect((await call('POST',policyPath,{...envelope(),action:'save',expectedRevision:0,bindings:binding})).body).toMatchObject({result:{revision:1}});
 const [waiting,blocking]=await Promise.all([pid(db),pid(f.db)]);
 await f.db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
 const command={...envelope(),action,expectedRevision:1,...(action==='save'?{bindings:binding}:{})};
 pending=call('POST',policyPath,command);
 await blocked(f.db,waiting,blocking);
 // Sign out the exact waiting session, not the independent observer session.
 if(loss==='sign-out')expect((await caller(f,owner.accessToken,await f.database.appRuntimeSession())('POST','/auth/sign-out',{})).status).toBe(200);
 else expect((await observe('POST','/devices/revoke',{deviceId:owner.deviceId})).status).toBe(200);
 await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
 expect(await pending).toMatchObject({status:409,body:{status:'refused',reason:'owner_authority_changed'}});
 const fresh=await issueSessionFor(f,f.alpha,f.alpha.admin,{deviceLabel:'read after authority loss'});
 const read=caller(f,fresh.accessToken,await f.database.appRuntimeSession());
 expect((await read('GET',policyPath)).body).toMatchObject({revision:1,setting:{status:'saved'}});
 }finally{
  await f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
  await pending?.catch(()=>undefined);await f.stop();
 }
});
