import {afterEach,describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import type {SocialPublisherAttempt,SocialPublisherBinding} from '@fss/contracts';
import {SocialBrowserPublisher} from '../src/publisherRuntime.ts';
import {sealPublisherSession,openPublisherSession,type PublisherSessionStore} from '../src/publisherSessions.ts';
import {publisherFixture} from './publisherFixture.ts';

const resources:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of resources.splice(0).reverse())await close();});
async function harness(){
 const fixture=await publisherFixture();resources.push(fixture.close);
 const binding:SocialPublisherBinding={workspaceId:randomUUID(),ownerUserId:randomUUID(),accountId:randomUUID(),accountRevision:1,sessionId:randomUUID(),sessionRevision:1,externalId:`${fixture.origin}/in/self`};
 let available=true;
 let state=JSON.stringify({cookies:[{name:'fixtureSession',value:'owned',domain:'127.0.0.1',path:'/',expires:-1,httpOnly:false,secure:false,sameSite:'Strict'}],origins:[]});
 const sessions:PublisherSessionStore={
  async read(request){return available&&JSON.stringify(request)===JSON.stringify(binding)?state:null;},
  async save(owner,accountId,identity,newState,authority){await authority();expect(owner.workspaceId).toBe(binding.workspaceId);expect(accountId).toBe(binding.accountId);expect(identity.externalId).toBe(binding.externalId);state=newState;return binding;},
  async disconnect(){available=false;},async heartbeat(){},
 };
 const runtime=new SocialBrowserPublisher({sessions,executionSide:'worker',browser:{kind:'local'}}, {origin:fixture.origin});resources.push(()=>runtime.close());
 const publishAt=new Date(Date.now()+86400000);publishAt.setUTCSeconds(0,0);
 const attempt:SocialPublisherAttempt={binding,attemptId:randomUUID(),fingerprint:'a'.repeat(64),text:'Fictional fixture-only founder update.',publishAt:publishAt.toISOString(),image:null};
 return {fixture,runtime,attempt,sessions,disconnect:()=>{available=false;}};
}
const authority=async()=>{};
describe('real isolated Chromium publisher against controlled native DOM',()=>{
 it('independently expands collapsed native text before claiming exact readback',async()=>{
  const {runtime,fixture,attempt}=await harness();fixture.state.truncate=true;attempt.text='A fictional long founder update with real paragraphs. '.repeat(20);
  expect((await runtime.submit(attempt,authority,async()=>true)).state).toBe('scheduled');expect(fixture.state.writes).toBe(1);
 },60000);
 it('schedules through final native click, independently inspects after process replacement, and cancels exact receipt',async()=>{
  const {runtime,fixture,attempt,sessions}=await harness();let marked=false;
  expect((await runtime.verify(attempt.binding)).usable).toBe(true);
  await runtime.prepare(attempt,authority);
  const result=await runtime.submit(attempt,authority,async()=>{expect(fixture.state.writes).toBe(0);marked=true;return true;});
  expect(marked).toBe(true);expect(result.state).toBe('scheduled');expect(result.receiptId).toBe('urn:li:activity:123456');expect(result.permalink).toBeNull();
  await runtime.close();
  const restarted=new SocialBrowserPublisher({sessions,executionSide:'worker',browser:{kind:'local'}},{origin:fixture.origin});resources.push(()=>restarted.close());
  expect((await restarted.inspect(attempt,result.receiptId,authority)).state).toBe('scheduled');
  expect((await restarted.cancel(attempt,result.receiptId!,authority)).state).toBe('cancelled');
  expect(fixture.state.writes).toBe(1);expect(fixture.state.cancelled).toBe(1);
 },60000);
 it('binds one loaded image and alt text, committing custody before any upload',async()=>{
  const {runtime,fixture,attempt}=await harness();
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  attempt.image={bytes,mime:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),altText:'Owned fixture image'};
  const result=await runtime.submit(attempt,authority,async()=>{expect(fixture.state.uploads).toBe(0);return true;});
  expect(result.state).toBe('scheduled');expect(result.loadedPreview).toBe(true);expect(result.imageCount).toBe(1);expect(fixture.state.uploads).toBe(1);
  const recovery:SocialPublisherAttempt={...attempt,image:{mime:attempt.image.mime,sha256:attempt.image.sha256,altText:''}};
  expect((await runtime.inspect(recovery,result.receiptId,authority)).state).toBe('scheduled');
  expect(await runtime.cancel(recovery,result.receiptId!,authority)).toMatchObject({state:'cancelled',loadedPreview:true,imageCount:1,reason:'matched',accountExternalId:attempt.binding.externalId,fingerprint:attempt.fingerprint});
  await expect(runtime.submit(recovery,authority,async()=>true)).rejects.toThrow('image_invalid');
 },60000);
 it('never repeats a marked submission, and an empty native list stays UNKNOWN',async()=>{
  const {runtime,fixture,attempt}=await harness();fixture.state.unknown=true;
  const result=await runtime.submit(attempt,authority,async()=>true);
  expect(result.state).toBe('unknown');expect(fixture.state.writes).toBe(1);
  expect((await runtime.submit(attempt,authority,async()=>false)).state).toBe('unknown');
  expect(fixture.state.writes).toBe(1);expect((await runtime.inspect(attempt,null,authority)).state).toBe('unknown');
 },60000);
 it('refuses wrong-account and disconnected sessions before custody or action',async()=>{
  const {runtime,fixture,attempt,disconnect}=await harness();fixture.state.account='other';let markers=0;
  await expect(runtime.submit(attempt,authority,async()=>{markers++;return true;})).rejects.toThrow('account_mismatch');
  expect(markers).toBe(0);expect(fixture.state.writes).toBe(0);disconnect();
  expect((await runtime.verify(attempt.binding)).usable).toBe(false);
  expect((await runtime.inspect(attempt,null,authority)).reason).toBe('session_unavailable');
 },60000);
 it('preserves publication winning a cancellation race instead of claiming deletion',async()=>{
  const {runtime,fixture,attempt}=await harness();const result=await runtime.submit(attempt,authority,async()=>true);fixture.state.publishOnCancel=true;
  expect((await runtime.cancel(attempt,result.receiptId!,authority)).state).toBe('published');expect(fixture.state.cancelled).toBe(0);
 },60000);
 it('stops across authority waits and retains uncertain marker failures without another click',async()=>{
  const {runtime,fixture,attempt}=await harness();
  const result=await runtime.submit(attempt,authority,async()=>{throw new Error('lost committed marker response');});
  expect(result.state).toBe('unknown');expect(fixture.state.writes).toBe(0);
  await expect(runtime.submit(attempt,async()=>{throw new Error('revoked');},async()=>true)).rejects.toThrow('revoked');expect(fixture.state.writes).toBe(0);
 },60000);
 it('establishes a normal owner login and refuses frame access from a different owner',async()=>{
  const {runtime,attempt}=await harness();
  const owner={workspaceId:attempt.binding.workspaceId,ownerUserId:attempt.binding.ownerUserId,sessionId:randomUUID(),deviceId:randomUUID()};
  const start=await runtime.connection(owner,{operation:'start',accountId:attempt.binding.accountId},authority);
  if(start.state!=='connecting')throw new Error('connection_not_started');
  await expect(runtime.connection({...owner,ownerUserId:randomUUID()},{operation:'frame',connectionId:start.connectionId},authority)).rejects.toThrow('connection_unavailable');
  await expect(runtime.connection({...owner,sessionId:randomUUID()},{operation:'frame',connectionId:start.connectionId},authority)).rejects.toThrow('connection_unavailable');
  // One real coordinate click submits the controlled fixture login form.
  await runtime.connection(owner,{operation:'input',connectionId:start.connectionId,event:{kind:'click',x:30,y:70}},authority).catch(()=>{});
  const connected=await runtime.connection(owner,{operation:'complete',connectionId:start.connectionId},authority);
  expect(connected.state).toBe('connected');
 },60000);
 it('revalidates a revocation across a real post-marker wait before any external write',async()=>{
  const {runtime,fixture,attempt}=await harness();
  const waiting=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let checks=0,revoked=false;
  const check=async()=>{if(++checks===4){waiting.resolve();await release.promise;}if(revoked)throw new Error('revoked');};
  const pending=runtime.submit(attempt,check,async()=>true);
  await waiting.promise;revoked=true;release.resolve();
  expect((await pending).state).toBe('unknown');expect(fixture.state.writes).toBe(0);expect(fixture.state.uploads).toBe(0);
 },60000);
 it('inspects and cancels by opaque digest after source prose is erased',async()=>{
  const {runtime,attempt}=await harness();const accepted=await runtime.submit(attempt,authority,async()=>true);
  const recovery={...attempt,text:null,textSHA256:createHash('sha256').update(attempt.text!.replace(/\r\n/gu,'\n').trim()).digest('hex')};
  expect((await runtime.inspect(recovery,accepted.receiptId,authority)).state).toBe('scheduled');
  expect((await runtime.cancel(recovery,accepted.receiptId!,authority)).state).toBe('cancelled');
  await expect(runtime.submit(recovery,authority,async()=>true)).rejects.toThrow('attempt_invalid');
 },60000);
 it('returns only a bounded transient login frame and withholds it after authority changes',async()=>{
  const {runtime,attempt}=await harness();
  const owner={workspaceId:attempt.binding.workspaceId,ownerUserId:attempt.binding.ownerUserId,sessionId:randomUUID(),deviceId:randomUUID()};
  const start=await runtime.connection(owner,{operation:'start',accountId:attempt.binding.accountId},authority);
  if(start.state!=='connecting')throw new Error('connection_not_started');
  const frame=await runtime.connection(owner,{operation:'frame',connectionId:start.connectionId},authority);
  expect(frame.state).toBe('frame');if(frame.state!=='frame')throw new Error('frame_unavailable');
  expect(frame.image.length).toBeLessThanOrEqual(600000);expect(Buffer.from(frame.image,'base64').subarray(0,2)).toEqual(Buffer.from([255,216]));
  await expect(runtime.connection(owner,{operation:'frame',connectionId:start.connectionId},async()=>{throw new Error('revoked');})).rejects.toThrow('revoked');
 },60000);
});
describe('private encrypted browser credentials',()=>{
 it('authenticates workspace/owner/account/session revisions and rejects tampering',()=>{
  const binding:SocialPublisherBinding={workspaceId:randomUUID(),ownerUserId:randomUUID(),accountId:randomUUID(),accountRevision:1,sessionId:randomUUID(),sessionRevision:1,externalId:'https://www.linkedin.com/in/fictional'};
  const key=Buffer.alloc(32,42),sealed=sealPublisherSession(key,binding,'private-cookie-fixture');
  expect(sealed.includes(Buffer.from('private-cookie-fixture'))).toBe(false);expect(openPublisherSession(key,binding,sealed)).toBe('private-cookie-fixture');
  expect(()=>openPublisherSession(key,{...binding,sessionRevision:2},sealed)).toThrow();
  sealed[sealed.length-1]=sealed[sealed.length-1]!^1;expect(()=>openPublisherSession(key,binding,sealed)).toThrow();
 });
});
