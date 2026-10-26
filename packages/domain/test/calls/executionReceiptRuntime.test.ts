import {randomUUID,randomBytes} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createApplyWorld,type ApplyWorld} from './support/applyWorld.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {createCallSession,consumeCallSession} from '../../calls/sessions.ts';
import {readCallingExecutionReceipt} from '../../calls/executionReceipt.ts';
import {CallingAuthorityChanged} from '../../calling/followUpDraftAccess.ts';
import {publishTestRegistrySnapshot} from '../support/nationalRegistry.ts';

describe('NEW receipt actual migrated app_runtime and consume serialization',()=>{
 let world:ApplyWorld,reader:SessionQueryable,writer:SessionQueryable;
 beforeAll(async()=>{world=await createApplyWorld();reader=await world.connection();writer=await world.connection();for(const db of [reader,writer])expect((await db.query<{current_user:string}>('SELECT current_user')).rows[0]?.current_user).toBe('app_runtime');console.log('CALLING_EXECUTION_FIXTURE_REGISTERED',world.database.name);});
 afterAll(async()=>{await world.drop();console.log('CALLING_EXECUTION_FIXTURE_DROPPED');});
 async function prepare(){
  const firm=await world.newFirm();const commandId=randomUUID(),payloadSHA256='a'.repeat(64);
  await publishTestRegistrySnapshot(world.session,world.seeded.alpha.workspaceId,{downloadedAt:new Date().toISOString(),publishedAt:new Date().toISOString(),e164s:[{e164:firm.e164,result:'clear'}]});
  const made=await withTransaction(writer,()=>createCallSession(world.salesperson(writer),{firmId:firm.firmId,contactId:firm.contactId,routeId:firm.routeId,routeVersion:firm.routeVersion,callingIdentityId:world.policy.alpha.callingIdentityId,deviceId:world.seeded.alpha.salesperson.deviceId,commandId,configuredCallerIdE164:'+14015550100',at:world.policy.insideWindow}));
  if(!made.ok)throw Error(made.reason);
  // Ticket issuance uses the real database clock even when decisionAt is fixed.
  const expiresAt=made.value.expiresAt;
  await world.session.query("INSERT INTO command_receipts(workspace_id,device_id,command_id,command_kind,payload_hash,result_status,result) VALUES($1,$2,$3,'create_call_session',$4,'accepted',$5::jsonb)",[world.seeded.alpha.workspaceId,world.seeded.alpha.salesperson.deviceId,commandId,payloadSHA256,JSON.stringify({sessionId:made.value.sessionId,expiresAt})]);
  return {input:{firmId:firm.firmId,commandId,payloadSHA256},sessionId:made.value.sessionId,expiresAt};
 }
 const read=(p:Awaited<ReturnType<typeof prepare>>,authority=async()=>true)=>readCallingExecutionReceipt(world.salesperson(reader),p.input,world.seeded.alpha.salesperson.deviceId,authority);
 async function blockedOn(db:SessionQueryable){const pid=(await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;for(let n=0;n<150;n++){if((await world.session.query<{n:string}>('SELECT count(*)::text AS n FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))',[pid])).rows[0]?.n!=='0')return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Expected actual PG lock wait not observed');}
 async function expiry(p:Awaited<ReturnType<typeof prepare>>,milliseconds:number){p.expiresAt=new Date(Date.now()+milliseconds).toISOString();await world.session.query('UPDATE call_sessions SET expires_at=$2 WHERE id=$1',[p.sessionId,p.expiresAt]);await world.session.query('UPDATE command_receipts SET result=$2::jsonb WHERE command_id=$1',[p.input.commandId,JSON.stringify({sessionId:p.sessionId,expiresAt:p.expiresAt})]);}
 const consume=(p:Awaited<ReturnType<typeof prepare>>)=>consumeCallSession(writer,{workspaceId:world.seeded.alpha.workspaceId,sessionId:p.sessionId,callSid:`CA${randomBytes(16).toString('hex')}`,identity:`client:${world.seeded.alpha.salesperson.userId}`,at:world.policy.insideWindow});
 it('read-only accepted receipt has actual app_runtime row-lock privileges and exact identity/hash/device/kind isolation',async()=>{
  const p=await prepare();expect(await withTransaction(reader,()=>read(p))).toMatchObject({state:'accepted',sessionId:p.sessionId,status:'authorized',canReconnect:false});
  const before=(await world.session.query('SELECT to_jsonb(s) AS row FROM call_sessions s WHERE id=$1',[p.sessionId])).rows;
  for(const input of [{...p.input,payloadSHA256:'b'.repeat(64)},{...p.input,commandId:randomUUID()}])expect(await withTransaction(reader,()=>readCallingExecutionReceipt(world.salesperson(reader),input,world.seeded.alpha.salesperson.deviceId,async()=>true))).toEqual({state:'unknown'});
  expect(await withTransaction(reader,()=>readCallingExecutionReceipt(world.salesperson(reader),p.input,world.seeded.alpha.admin.deviceId,async()=>true))).toEqual({state:'unknown'});
  expect((await world.session.query('SELECT to_jsonb(s) AS row FROM call_sessions s WHERE id=$1',[p.sessionId])).rows).toEqual(before);
 });
 it('clock is evaluated after an observed session lock wait beyond expiry',async()=>{
  const p=await prepare();await expiry(p,350);await writer.query('BEGIN');await writer.query('SELECT id FROM call_sessions WHERE id=$1 FOR UPDATE',[p.sessionId]);
  const result=withTransaction(reader,()=>read(p));try{await blockedOn(writer);await new Promise(resolve=>setTimeout(resolve,450));}finally{await writer.query('COMMIT');}
  expect(await result).toMatchObject({state:'accepted',status:'expired_unconsumed'});
 });
 it('actual consume first serializes receipt and consumed status never becomes expired_unconsumed',async()=>{
  const p=await prepare();await writer.query('BEGIN');expect(await consume(p)).toMatchObject({ok:true});const result=withTransaction(reader,()=>read(p));try{await blockedOn(writer);}finally{await writer.query('COMMIT');}
  expect(await result).toMatchObject({state:'accepted',status:'authorized'});
  await world.session.query('UPDATE call_sessions SET expires_at=consumed_at WHERE id=$1',[p.sessionId]);
  const current=(await world.session.query<{expires_at:Date}>('SELECT expires_at FROM call_sessions WHERE id=$1',[p.sessionId])).rows[0]!.expires_at.toISOString();
  await world.session.query('UPDATE command_receipts SET result=$2::jsonb WHERE command_id=$1',[p.input.commandId,JSON.stringify({sessionId:p.sessionId,expiresAt:current})]);
  expect(await withTransaction(reader,()=>read(p))).toMatchObject({state:'accepted',status:'authorized'});
 });
 it('expired receipt first holds real consumption until commit then actual consume refuses expiry',async()=>{
  const p=await prepare();await expiry(p,-1);await reader.query('BEGIN');expect(await read(p)).toMatchObject({state:'accepted',status:'expired_unconsumed'});
  const result=withTransaction(writer,()=>consume(p));try{await blockedOn(reader);}finally{await reader.query('COMMIT');}
  expect(await result).toMatchObject({ok:false,reason:'session_expired'});
 });
 it('fresh authority is checked after a real row wait and rejects revoked membership',async()=>{
  const p=await prepare();await writer.query('BEGIN');await writer.query('SELECT id FROM call_sessions WHERE id=$1 FOR UPDATE',[p.sessionId]);
  const result=withTransaction(reader,()=>read(p));const observed=result.then(value=>({value}),error=>({error}));
  try{await blockedOn(writer);await world.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[world.seeded.alpha.workspaceId,world.seeded.alpha.salesperson.userId]);}finally{await writer.query('COMMIT');}
  expect(await observed).toMatchObject({error:expect.any(CallingAuthorityChanged)});
  await world.session.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[world.seeded.alpha.workspaceId,world.seeded.alpha.salesperson.userId]);
 });
});
