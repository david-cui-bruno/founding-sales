import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {access,readFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import pg from 'pg';
import {startPostgresCluster} from '../../db/testing/embeddedPostgres.ts';
import {createTemplateDatabase,CLUSTER_URL_ENVIRONMENT_VARIABLE,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {createOwnedTeardown} from '../../db/testing/globalSetup.ts';
import type {AuthFixture} from '../../../../apps/api/test/support/authFixture.ts';
const homebrew=()=>execFileSync('ps',['-p','1106','-o','pid=,lstart=,command='],{encoding:'utf8'}).trim();
async function admin<T>(work:(client:pg.Client)=>Promise<T>){const c=new pg.Client({connectionString:process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]});await c.connect();try{return await work(c);}finally{await c.end();}}
async function absentPort(port:number){for(const host of ['127.0.0.1','::1'])await new Promise<void>((resolve,reject)=>{const s=createConnection({host,port});s.setTimeout(2000,()=>{s.destroy();reject(Error('Listener absence timeout'));});s.once('connect',()=>{s.destroy();reject(Error(`Owned listener remains ${port}`));});s.once('error',e=>{try{assert.equal((e as NodeJS.ErrnoException).code,'ECONNREFUSED');resolve();}catch(error){reject(error);}});});}
export async function registerVoiceDatabase(db:TestDatabase){
 const backends=(await db.session.query('SELECT pid,backend_type FROM pg_stat_activity WHERE datname=current_database()')).rows;
 console.log('SOCIAL_VOICE_DATABASE_REGISTERED',JSON.stringify({workerPid:process.pid,database:db.name,backends}));
 return async()=>{await db.drop();await admin(async c=>{assert.equal((await c.query('SELECT 1 FROM pg_database WHERE datname=$1',[db.name])).rowCount,0);});console.log('SOCIAL_VOICE_DATABASE_ABSENT',JSON.stringify({database:db.name}));};
}
export async function registerVoiceFixture(f:AuthFixture){
 const drop=await registerVoiceDatabase(f.database),port=Number(new URL(f.google.issuer).port);
 console.log('SOCIAL_VOICE_OIDC_REGISTERED',JSON.stringify({workerPid:process.pid,port,database:f.database.name}));
 return async()=>{await f.google.stop();await drop();await absentPort(port);console.log('SOCIAL_VOICE_OIDC_ABSENT',JSON.stringify({port,ipv4:'ECONNREFUSED',ipv6:'ECONNREFUSED'}));};
}
/** Root's14:18 exclusive disposable PG/API grant. Canonical owners create/drop
 * resources. Exact observations supplement, never replace, their teardown. */
export default async function setup(){
 assert.equal(process.env['FSS_SOCIAL_VOICE_PG_GRANT'],'783-root-20261026T1418');
 assert.equal(process.env['FSS_TEST_POSTGRES_URL'],undefined);
 const before=homebrew();assert.match(before,/postgres/u);
 console.log('SOCIAL_VOICE_PARENT_REGISTERED',JSON.stringify({pid:process.pid,parentPid:process.ppid,homebrew1106:before,grant:'2026-10-26T14:18:25Z'}));
 const cluster=await startPostgresCluster();
 try{
  assert.equal(cluster.source,'embedded');assert(cluster.storagePath);
  const pid=Number((await readFile(`${cluster.storagePath}/postmaster.pid`,'utf8')).split('\n')[0]),port=Number(new URL(cluster.adminUrl).port);
  process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]=cluster.adminUrl;
  const children=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').filter(l=>Number(l.trim().split(/\s+/u)[1])===pid);
  console.log('SOCIAL_VOICE_CLUSTER_REGISTERED',JSON.stringify({pid,port,storagePath:cluster.storagePath,children}));
  await admin(async c=>{const row=(await c.query("SELECT current_setting('server_version_num') version,current_setting('server_encoding') encoding")).rows[0];assert.match(row.version,/^16/u);assert.equal(row.encoding,'UTF8');});
  const template=await createTemplateDatabase(cluster.adminUrl);process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]=template.name;
  console.log('SOCIAL_VOICE_TEMPLATE_REGISTERED',JSON.stringify({template:template.name}));
  const release=createOwnedTeardown([
   async()=>{await admin(async c=>{const rows=(await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'fss_test_%'")).rows;console.log('SOCIAL_VOICE_CHILDREN_AT_TEARDOWN',JSON.stringify(rows));assert.equal(rows.length,0);});},
   ()=>template.drop(),
   async()=>{await admin(async c=>{assert.equal((await c.query('SELECT 1 FROM pg_database WHERE datname=$1',[template.name])).rowCount,0);});},
   ()=>cluster.stop(),
   async()=>{await absentPort(port);await access(cluster.storagePath!).then(()=>{throw Error('Owned storage remains');},e=>assert.equal((e as NodeJS.ErrnoException).code,'ENOENT'));assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(homebrew(),before);console.log('SOCIAL_VOICE_INDEPENDENT_ABSENCE',JSON.stringify({pid,port,storagePath:cluster.storagePath,template:template.name,homebrew1106Unchanged:true}));},
  ]);
  return async()=>{try{await release();}finally{delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];delete process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE];}};
 }catch(error){await cluster.stop();assert.equal(homebrew(),before);throw error;}
}
