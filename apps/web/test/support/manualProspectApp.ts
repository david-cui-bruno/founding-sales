import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {access,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer as reserveServer,type AddressInfo} from 'node:net';
import type {RequestListener} from 'node:http';
import type {Server} from 'node:https';
import pg from 'pg';
import {asSession,CLUSTER_URL_ENVIRONMENT_VARIABLE,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE} from '@fss/domain/db/testing/testDatabase.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION,type SeededMember} from '../../../api/test/support/authFixture.ts';
import {createBrowserServer} from '../../src/server/server.ts';
import {buildBrowserAssets} from '../../src/server/assets.ts';
import {readBrowserHostSettings} from '../../src/server/settings.ts';
import type {BrowserRuntime} from '../../src/server/runtime.ts';
import {localCertificate} from './tls.ts';
import {reserveLocalBrowserDatabase} from './database.ts';

async function absent(path:string):Promise<void>{await access(path).then(()=>{throw Error('Owned resource remains');},error=>{assert.equal((error as NodeJS.ErrnoException).code,'ENOENT');});}
async function port():Promise<number>{const server=reserveServer();await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'localhost',resolve);});const value=(server.address() as AddressInfo).port;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return value;}
/** Ticket764 exclusive local harness. All actual API/auth requests SET ROLE app_runtime.
 * Signed provider navigation alone is synthetic. No bypass, workers or paid ports.
 */
export async function startManualProspectApp(){
 assert.equal(process.env['FSS_MANUAL_PROSPECT_EXCLUSIVE_LANE'],'764');
 const executable=process.env['FSS_LOCAL_BROWSER_EXECUTABLE'];assert(executable);await access(executable);
 const postgres=execFileSync('ps',['-axo','pid,ppid,command'],{encoding:'utf8'}).split('\n').filter(line=>/(?:^|\s)(?:\S*\/)?postgres(?:\s|$)/u.test(line)&&!/postgres: /u.test(line));
 assert(postgres.every(line=>line.includes('/opt/homebrew/opt/postgresql@17/bin/postgres -D /opt/homebrew/var/postgresql@17')),'Another disposable PostgreSQL lane is active');
 const release=await reserveLocalBrowserDatabase();
 const fixture=await createAuthFixture().catch(async error=>{await release();throw error;});
 const certificate=await localCertificate().catch(async error=>{try{await fixture.stop();}finally{await release();}throw error;});
 let server:Server|undefined;
 try{
  const storagePath=String((await fixture.db.query('SHOW data_directory')).rows[0]?.['data_directory']);
  const postgresPid=Number((await readFile(join(storagePath,'postmaster.pid'),'utf8')).split('\n')[0]);
  const tlsPaths=await Promise.all((await readdir(tmpdir())).filter(name=>name.startsWith('fss-browser-tls-')).map(async name=>{const path=join(tmpdir(),name);try{return (await readFile(join(path,'cert.pem'))).equals(certificate.cert)?path:null;}catch{return null;}}));
  const tlsPath=tlsPaths.find(value=>value!==null);assert(tlsPath);
  const origin=`https://localhost:${await port()}`,assets=await buildBrowserAssets();
  const settings=readBrowserHostSettings({FSS_BROWSER_ORIGIN:origin,FSS_BROWSER_CLIENT_VERSION:CURRENT_CLIENT_VERSION,FSS_BROWSER_COOKIE_KEY_HEX:randomBytes(32).toString('hex')});
  const config={...fixture.deps.config,oidc:{...fixture.deps.config.oidc,redirectUri:`${origin}/browser/callback`}};
  let identity:SeededMember=fixture.alpha.admin,runtimeRequests=0;
  const runtime:BrowserRuntime={...settings,withRequest:async work=>{
   const url=new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);url.pathname=`/${fixture.database.name}`;const client=new pg.Client({connectionString:url.href});await client.connect();
   try{
    await client.query('SET ROLE app_runtime');assert.equal((await client.query('SELECT current_user')).rows[0]?.['current_user'],'app_runtime');runtimeRequests++;
    const db=asSession({query:async(text,values)=>client.query(text,values),connect:async()=>{},end:async()=>{}}),auth={...fixture.deps,config,db};
    return await work({auth,api:{session:db,auth,supportedClientVersions:config.supportedClientVersions,sendingEnabled:false,production:false}});
   }finally{await client.end();}
  }};
  server=await createBrowserServer({settings,withRequest:runtime.withRequest,tls:certificate,assets,bodyTimeoutMs:150});
  const product=server.listeners('request')[0] as RequestListener;assert.equal(server.listeners('request').length,1);server.removeListener('request',product);
  server.on('request',(request,response)=>{
   const url=new URL(request.url??'/',origin);if(url.pathname!=='/__local/provider')return product(request,response);
   const code=`manual-${randomUUID()}`;fixture.google.issueCode(code);const now=Math.floor(fixture.deps.now().getTime()/1000);
   fixture.google.nextIdToken(fixture.google.signIdToken({sub:identity.googleSub,email:identity.email,hd:fixture.hostedDomain,nonce:url.searchParams.get('nonce')??'',iat:now,exp:now+3600}));
   const callback=new URL('/browser/callback',origin);callback.searchParams.set('code',code);callback.searchParams.set('state',url.searchParams.get('state')??'');response.writeHead(302,{location:callback.href,'cache-control':'no-store'});response.end();
  });
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(Number(new URL(origin).port),'localhost',resolve);});
  console.log('MANUAL_PROSPECT_764_RESOURCES',JSON.stringify({storagePath,postgresPid,tlsPath,database:fixture.database.name,template:process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE],httpsPort:Number(new URL(origin).port)}));
  return {fixture,origin,chooseIdentity:(member:SeededMember)=>{identity=member;},runtimeRequests:()=>runtimeRequests,stop:async()=>{
   try{server!.closeAllConnections();await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));assert(!server!.listening);}
   finally{try{
    await fixture.stop();const admin=new pg.Client({connectionString:process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]});await admin.connect();try{assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[fixture.database.name])).rowCount,0);}finally{await admin.end();}
   }finally{try{await certificate.remove();await absent(tlsPath);}finally{await release();await absent(storagePath);assert.throws(()=>process.kill(postgresPid,0),{code:'ESRCH'});assert.equal(process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE],undefined);console.log('MANUAL_PROSPECT_764_RELEASED: exact DB/template/PG process/storage/HTTPS/TLS absence verified, Homebrew untouched');}}}
  }};
 }catch(error){server?.closeAllConnections();if(server?.listening)await new Promise<void>(resolve=>server!.close(()=>resolve()));try{await fixture.stop();}finally{try{await certificate.remove();}finally{await release();}}throw error;}
}
export type ManualProspectApp=Awaited<ReturnType<typeof startManualProspectApp>>;
