import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {build} from 'esbuild';
import type {BrowserContext} from 'playwright/test';
import {createOwnedTeardown} from '@fss/domain/db/testing/globalSetup.ts';
import {consumeCallSession,recordCallStatus} from '@fss/domain/calls/sessions.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {publishTestRegistrySnapshot} from '../../../../packages/domain/test/support/nationalRegistry.ts';
import {seedPolicy} from '../../../../packages/domain/test/db/support/policyFixtures.ts';
import type {TwoWorkspaces} from '../../../../packages/domain/test/db/support/fixtures.ts';
import {requireGlassRuntimeGrant,glassCase} from './glassWorkspaceApp.ts';
import {reserveLocalBrowserDatabase} from './database.ts';
import {startReplyBriefApp} from './replyBriefApp.ts';
import {absent,listenerAbsent} from './founderHostResources.ts';
import {seedGlassWorkspace} from './glassWorkspaceSeed.ts';
import type {BrowserAssets} from '../../src/server/hostContract.ts';

async function fakeSDKAssets(){
 const built=await build({absWorkingDir:fileURLToPath(new URL('../../',import.meta.url)),entryPoints:[fileURLToPath(new URL('../../src/client/main.tsx',import.meta.url))],outdir:'calling-execution-test-build',entryNames:'renderer',bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',jsx:'automatic',minify:true,legalComments:'none',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'calling-test-no-provider-sdk',setup(plugin){plugin.onResolve({filter:/^@twilio\/voice-sdk$/},()=>({path:fileURLToPath(new URL('./callingExecutionFakeSDK.ts',import.meta.url))}));}}]});
 const js=built.outputFiles.find(f=>f.path.endsWith('/renderer.js')),css=built.outputFiles.find(f=>f.path.endsWith('/renderer.css'));assert(js&&css&&built.outputFiles.length===2);
 return (original:BrowserAssets):BrowserAssets=>new Map([...original,['/renderer.js',{body:js.contents,contentType:'text/javascript; charset=utf-8'}],['/styles.css',{body:css.contents,contentType:'text/css; charset=utf-8'}]]);
}
export async function startCallingExecutionApp(){
 requireGlassRuntimeGrant();const grant=process.env['FSS_CALLING_EXECUTION_RUNTIME_GRANT'];assert(grant==='aefb95a4d'||grant==='229d9a53d');
 const homebrew=execFileSync('ps',['-p','1106','-o','command='],{encoding:'utf8'}).trim();assert(homebrew.includes('/opt/homebrew/opt/postgresql@17/bin/postgres'));
 console.log('CALLING_EXECUTION_RESOURCES_RESERVED',JSON.stringify({owner:'swan',grant,resources:['sole disposable PG/template/fixture','loopback HTTPS/signed OIDC','isolated installed Chrome'],artifacts:process.env['FSS_GLASS_PRIVATE_ARTIFACTS'],homebrew1106:homebrew,workers:1,provider:'FAKE ONLY',audio:'FAKE ONLY'}));
 const decorateAssets=await fakeSDKAssets();const release=await reserveLocalBrowserDatabase();let app:Awaited<ReturnType<typeof startReplyBriefApp>>|undefined;
 const counters={tokens:0,connects:0,providerNetwork:0,externalBrowser:0,externalNode:0};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){counters.externalNode++;throw Error('Calling acceptance outbound network denied');}return originalFetch(input,init);};
 const at='2026-10-26T15:00:00.000Z';
 try{
  app=await startReplyBriefApp({conversation:glassCase,requestDatabaseRole:'app_runtime',decorateAssets,apiIntegrations:{publicOrigin:null,calcom:null,decisionAt:()=>at,twilio:{accountSid:`AC${'0'.repeat(32)}`,twimlAppSid:`AP${'0'.repeat(32)}`,callerIdE164:'+14015550100',verifySignature:()=>false,mintAccessToken:(_identity,now)=>{counters.tokens++;return {token:'FICTIONAL-CALLING-TOKEN-NOT-A-CREDENTIAL',expiresAtSeconds:now+3600};},fetchRecording:async()=>{counters.providerNetwork++;throw Error('Recording forbidden');}}}});
  const owned=app,httpsPort=Number(new URL(owned.origin).port),oidcPort=Number(new URL(owned.fixture.google.issuer).port);
  console.log('CALLING_EXECUTION_RUNTIME_REGISTERED',JSON.stringify({origin:owned.origin,oidc:owned.fixture.google.issuer,database:owned.fixture.database.name,template:process.env['FSS_TEST_TEMPLATE_DATABASE'],postgresPid:owned.postgresPid,storage:owned.storagePath,tls:owned.tlsPath}));
  const stop=createOwnedTeardown([()=>owned.stop(),async()=>{await listenerAbsent(httpsPort,'localhost');await listenerAbsent(oidcPort,'localhost');},release,async()=>{globalThis.fetch=originalFetch;await absent(owned.storagePath);await absent(owned.tlsPath);assert.throws(()=>process.kill(owned.postgresPid,0),{code:'ESRCH'});assert.equal(execFileSync('ps',['-p','1106','-o','command='],{encoding:'utf8'}).trim(),homebrew);console.log('CALLING_EXECUTION_ALL_RESOURCES_ABSENT_HOME BREW1106_UNCHANGED');}]);
  return {app:owned,counters,at,stop};
 }catch(error){try{await createOwnedTeardown([async()=>{await app?.stop();},release])();}finally{globalThis.fetch=originalFetch;}throw error;}
}
export type CallingExecutionApp=Awaited<ReturnType<typeof startCallingExecutionApp>>;
export async function seedCallingExecution(owned:CallingExecutionApp){
 const {app}=owned,f=app.fixture;const seed=await seedGlassWorkspace(app);
 await f.db.query("UPDATE firms SET time_zone='America/Chicago',time_zone_confidence='medium',time_zone_source='state_default',time_zone_rule_version='firm-zone.1' WHERE id=$1",[seed.preparedFirmId]);
 await f.db.query("INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550187','research_provider',now(),0.95,'passed','usable','route-policy.1')",[f.alpha.workspaceId,seed.preparedFirmId]);
 // The existing seed helper only reads these user/workspace fields. Device IDs are
 // not synthesized into HTTP authority. Actual signed OIDC creates its own device.
 const map=(w:typeof f.alpha)=>({...w,admin:{...w.admin,membershipId:'unused',deviceId:'unused'},salesperson:{...w.salesperson,membershipId:'unused',deviceId:'unused'}});
 const members:TwoWorkspaces={alpha:map(f.alpha),beta:map(f.beta),collidingCommandId:'unused',collidingE164:'+14015550187',collidingJobKey:{kind:'unused',idempotencyKey:'unused'},sharedEmail:'fictional@example.test'};
 // Seed a real independent beta Firm so policy fixture provenance remains scoped.
 const betaFirm=(await f.db.query<{id:string}>("INSERT INTO firms(workspace_id,name,assigned_user_id,region_code) VALUES($1,'FICTIONAL Calling beta',$2,'RI') RETURNING id",[f.beta.workspaceId,f.beta.salesperson.userId])).rows[0]!.id;
 await f.db.query("INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550187','research_provider',now(),0.95,'passed','usable','route-policy.1')",[f.beta.workspaceId,betaFirm]);
 const policy=await seedPolicy(f.db,members,{alpha:{firmId:seed.preparedFirmId,contactId:'',opportunityId:''},beta:{firmId:betaFirm,contactId:'',opportunityId:''},collidingFirmName:'FICTIONAL',collidingEmail:'fixture@example.test',collidingE164:'+14015550187'});
 await f.db.query("UPDATE state_postures SET state='TX' WHERE workspace_id=$1",[f.alpha.workspaceId]);
 // Keep the salesperson identity distinct, so current-own identity projection is tested.
 await f.db.query('UPDATE calling_identities SET e164=$2 WHERE id=$1',[policy.alpha.callingIdentityId,'+14015550103']);
 await f.db.query('UPDATE calling_identities SET e164=$2 WHERE id=$1',[policy.alpha.otherCallingIdentityId,'+14015550100']);
 for(const [key,value] of Object.entries({calling_provider:{provider:'twilio'},telephony_budget:{dailyCeilingCents:1000,maxMinutesPerCall:5,unitPriceMicros:14000}}))await f.db.query('INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,$2,1,$3::jsonb,$4)',[f.alpha.workspaceId,key,JSON.stringify(value),f.alpha.admin.userId]);
 await publishTestRegistrySnapshot(f.db,f.alpha.workspaceId,{downloadedAt:new Date().toISOString(),publishedAt:new Date().toISOString(),e164s:[{e164:'+14015550187',result:'clear'}]});
 return {...seed,identityId:policy.alpha.otherCallingIdentityId};
}
export async function installCallingFake(context:BrowserContext,owned:CallingExecutionApp){
 await context.addInitScript(()=>{window.__callingFake={constructed:0,connects:[],destroyed:0,disconnects:0,microphones:0};Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{window.__callingFake.microphones++;return {getTracks:()=>[{stop(){}}]};}});});
 await context.exposeBinding('__callingFakeConnect',async(_source,input:{sessionId:string})=>{
  owned.counters.connects++;const db=await owned.app.fixture.database.appRuntimeSession();const sid=`CA${randomBytes(16).toString('hex')}`;
  const consumed=await withTransaction(db,()=>consumeCallSession(db,{workspaceId:owned.app.fixture.alpha.workspaceId,sessionId:input.sessionId,callSid:sid,identity:`client:${owned.app.fixture.alpha.admin.userId}`,at:owned.at}));assert(consumed.ok,consumed.ok?'':consumed.reason);
  await withTransaction(db,()=>recordCallStatus(db,{callSid:sid,providerStatus:'in-progress'}));
 });
}
