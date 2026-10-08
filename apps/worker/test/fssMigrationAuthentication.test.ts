import {createServer,type Socket} from 'node:net';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import {createTestDatabase,CLUSTER_URL_ENVIRONMENT_VARIABLE,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {main} from '../src/tools/fss.ts';
let database:TestDatabase;
let url:URL;
beforeAll(async()=>{database=await createTestDatabase({throughVersion:61});url=new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);url.pathname=`/${database.name}`;});
afterAll(async()=>{await database.drop();});
async function run(connection:string|undefined,expected:Record<string,string>={}){
 const stdout:string[]=[],stderr:string[]=[];
 const out=vi.spyOn(process.stdout,'write').mockImplementation(s=>{stdout.push(String(s));return true;});
 const err=vi.spyOn(process.stderr,'write').mockImplementation(s=>{stderr.push(String(s));return true;});
 try{return {code:await main(['migration-auth-check','--expected-database',expected['database']??database.name,'--expected-user',expected['user']??decodeURIComponent(url.username),'--expected-host',expected['host']??url.hostname],{FSS_MIGRATION_DATABASE_URL:connection,DATABASE_URL:'postgresql://bad-runtime-credential@127.0.0.1:1/unavailable'}),stdout:stdout.join(''),stderr:stderr.join('')};}finally{out.mockRestore();err.mockRestore();}
}
describe('migration authentication through the FSS command line',()=>{
 it('checks the migration database read-only before the target schema is applied, ignoring runtime credentials',async()=>{
  const result=await run(url.toString());
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ok:true,database:database.name,identity:decodeURIComponent(url.username),schemaVersion:61,readOnly:true});
 });
 it.each([{database:'wrong_database'},{user:'app_runtime_login'},{host:'wrong.example.com'}])('refuses a connection whose expected identity or endpoint differs: %j',async(expected)=>{
  const result=await run(url.toString(),expected);
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stdout).reason).toBe('migration_binding_mismatch');
 });
 it('does not use a configured runtime credential when the migration credential is missing',async()=>{
  const result=await run(undefined);expect(result.code).toBe(20);expect(JSON.parse(result.stdout).reason).toBe('migration_credential_missing');
 });
 it('refuses a stalled PostgreSQL handshake within a bounded timeout',async()=>{
  const sockets:Socket[]=[];const server=createServer(socket=>{sockets.push(socket);});
  await new Promise<void>(resolve=>{server.listen(0,'127.0.0.1',resolve);});
  try{
   const address=server.address();if(!address||typeof address==='string')throw new Error('TCP fixture address missing');
   const stalled=new URL(url);stalled.port=String(address.port);
   const started=Date.now();const result=await run(stalled.toString());
   expect(result.code).toBe(20);expect(JSON.parse(result.stdout).reason).toBe('connection_timeout');
   expect(Date.now()-started).toBeLessThan(15_000);
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>{server.close(()=>{resolve();});});}
 });
 it('refuses a stale password with a sanitized authentication result',async()=>{
  const wrong=new URL(url);wrong.password='stale-password-do-not-print';
  const result=await run(wrong.toString());
  expect(result.code).toBe(20);
  expect(result.stdout).toContain('authentication_failed');
  expect(result.stdout+result.stderr).not.toContain('stale-password-do-not-print');
 });
});
