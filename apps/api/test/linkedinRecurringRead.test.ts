import {it,expect} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {linkedinRecurringViewSchema} from '@fss/contracts';
import {wireDrift} from '../../../packages/contracts/src/wire.ts';
import {dispatch} from '../src/server.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {recurringFixture} from './support/linkedinRecurringFixture.ts';

/** SQL below is synchronization/observation only. Every policy, draft, spend and
 * submission comes from normal commands and registered controlled workers. */
async function pid(db:SessionQueryable){return (await db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;}
async function blocked(db:SessionQueryable,waiting:number,blocking:number){
 for(let i=0;i<200;i++){
  const result=await db.query<{blocked:boolean}>('SELECT $2=ANY(pg_blocking_pids($1)) AS blocked',[waiting,blocking]);
  if(result.rows[0]?.blocked)return;
  await delay(5);
 }
 throw new Error('Recurring read did not reach the controlled PostgreSQL owner lock');
}

it.each(['sign_out','device_revoke','unchanged'] as const)('recurring private read revalidates %s after a real owner/policy lock wait',async change=>{
 const h=await recurringFixture();
 const grant=await issueSessionFor(h.f,h.f.alpha,h.f.alpha.admin,{deviceLabel:'Recurring read subject'});
 const reader=await h.f.database.appRuntimeSession(),control=await h.f.database.appRuntimeSession();
 const call=(path:string,body:unknown,session:SessionQueryable=control)=>dispatch({method:'POST',path,query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},body},{session,auth:{...h.f.deps,db:session},supportedClientVersions:h.f.deps.config.supportedClientVersions,sendingEnabled:false,linkedinRecurring:h.runtime});
 const key=`linkedin-posting-policy:${h.f.alpha.workspaceId}:${h.f.alpha.admin.userId}`;
 let pending:ReturnType<typeof call>|undefined;
 try{
  await h.prepare();await h.run();expect((await h.submit({unknown:true})).outcome).toEqual({state:'unknown'});
  const original=await call('/social/linkedin-recurring/read',{});
  expect(wireDrift(linkedinRecurringViewSchema,original.body)).toEqual([]);
  const current=linkedinRecurringViewSchema.parse(original.body);
  expect(current.items[0]).toMatchObject({state:'unknown_paused',postId:expect.any(String),submissionId:expect.any(String),spendCents:1});
  const waiting=await pid(reader),blocking=await pid(h.f.db);
  await h.f.db.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[key]);
  pending=call('/social/linkedin-recurring/read',{},reader);
  await blocked(h.f.db,waiting,blocking);
  if(change==='sign_out')expect((await call('/auth/sign-out',{})).status).toBe(200);
  if(change==='device_revoke')expect((await call('/devices/revoke',{deviceId:grant.deviceId})).status).toBe(200);
  expect((await control.query<{status:string}>('SELECT status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[h.f.alpha.workspaceId,h.f.alpha.admin.userId])).rows[0]?.status).toBe('active');
  await h.f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
  const answer=await pending;
  if(change==='unchanged'){
   expect(answer.status).toBe(200);expect(wireDrift(linkedinRecurringViewSchema,answer.body)).toEqual([]);expect(linkedinRecurringViewSchema.parse(answer.body)).toEqual(current);
  }else{
   expect(answer.status).toBe(401);
   expect(answer.body).not.toHaveProperty('items');expect(answer.body).not.toHaveProperty('holds');
   expect(JSON.stringify(answer.body)).not.toContain(current.items[0]!.postId!);
   expect(JSON.stringify(answer.body)).not.toContain(current.items[0]!.submissionId!);
   // A revoked reader cannot recover any owner-private history through replay.
   expect((await call('/social/linkedin-recurring/read',{})).status).toBe(401);
  }
  expect(h.counts).toEqual({generations:1,submissions:1});
 }finally{
  await h.f.db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);
  await pending?.catch(()=>undefined);await h.f.stop();
 }
});

it('recurring read request remains exact and cannot supply publication authority',async()=>{
 const h=await recurringFixture();try{
  const answer=await h.call('/social/linkedin-recurring/read',{enabled:true,authority:true});
  expect(answer).toMatchObject({status:400,body:{error:'invalid_input'}});
  expect(h.counts).toEqual({generations:0,submissions:0});
  expect((await h.call('/social/linkedin-recurring/read',{})).status).toBe(200);
 }finally{await h.f.stop();}
});
