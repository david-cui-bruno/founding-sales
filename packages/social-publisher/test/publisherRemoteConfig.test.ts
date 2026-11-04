import {describe,it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {publisherProductionConfiguration,publisherControlToken,publisherRemoteEndpoint,assertPublisherDebugDisabled} from '../src/publisherConfig.ts';
import {startSocialPublisher} from '../src/startup.ts';

const key=Buffer.alloc(32,19).toString('base64'),token=Buffer.alloc(32,23).toString('base64');
const endpoint='wss://sales.usecallie.com/social/publisher-runtime/browser';
const configuration={FSS_SOCIAL_PUBLISHER_SESSION_KEY:key,FSS_SOCIAL_PUBLISHER_ENDPOINT:endpoint,FSS_SOCIAL_PUBLISHER_TOKEN:token};
describe('production remote publisher authority',()=>{
 it.each([
  {FSS_SOCIAL_PUBLISHER_SESSION_KEY:key},
  {FSS_SOCIAL_PUBLISHER_ENDPOINT:endpoint},
  {FSS_SOCIAL_PUBLISHER_TOKEN:token},
  {FSS_SOCIAL_PUBLISHER_SESSION_KEY:key,FSS_SOCIAL_PUBLISHER_ENDPOINT:endpoint},
 ])('refuses partial production configuration instead of a local native fallback %#',async environment=>{
  await expect(startSocialPublisher({environment,executionSide:'worker',openSession:async()=>{throw new Error('database_must_not_be_reached');},onHeartbeatError:()=>{throw new Error('heartbeat_must_not_be_reached');}})).rejects.toThrow('publisher_configuration_incomplete');
 });
 it.each([undefined,'','not-a-secret',Buffer.alloc(31).toString('base64'),Buffer.alloc(33).toString('base64'),`${token}\n`,token.replace(/=$/u,'')])('requires a canonical exact32byte control token %#',raw=>{
  expect(()=>publisherControlToken(raw)).toThrow('publisher_control_token_invalid');
 });
 it.each([
  'ws://sales.usecallie.com/social/publisher-runtime/browser',
  'https://sales.usecallie.com/social/publisher-runtime/browser',
  'wss://user:private-fixture@sales.usecallie.com/social/publisher-runtime/browser',
  `${endpoint}?token=private-fixture`,`${endpoint}?`,`${endpoint}#private-fixture`,`${endpoint}/`,
  'wss://sales.usecallie.com/social/publisher-runtime/%62rowser',
 ])('rejects cleartext, identity/query-bearing and nonexact endpoints %#',value=>{
  expect(()=>publisherRemoteEndpoint(value)).toThrow('publisher_remote_endpoint_invalid');
  expect(()=>publisherRemoteEndpoint(value)).not.toThrow(/private-fixture/u);
 });
 it('refuses encryption-key reuse and TLS-verification bypass independently of endpoint validity',()=>{
  expect(()=>publisherProductionConfiguration({...configuration,FSS_SOCIAL_PUBLISHER_TOKEN:key})).toThrow('publisher_separate_control_token_required');
  expect(()=>publisherProductionConfiguration({...configuration,NODE_TLS_REJECT_UNAUTHORIZED:'0'})).toThrow('publisher_tls_verification_required');
 });
 it.each([{DEBUG:'pw:protocol'},{PWDEBUG:'console'},{NODE_DEBUG:'http'},{NODE_OPTIONS:'--inspect=0.0.0.0:9229'}])('refuses credential-bearing protocol/process debugging %#',environment=>{
  expect(()=>assertPublisherDebugDisabled(environment)).toThrow('publisher_debug_logging_refused');
 });
});
describe('browser-only entrypoint isolation',()=>{
 it.each([
  {DATABASE_URL:'postgresql://private-fixture-db/never-connect'},
  {PGPASSWORD:'private-fixture-database-password'},
  {PGSSLMODE:'verify-full'},
  {FSS_ROLE:'api'},
  {FSS_SOCIAL_PUBLISHER_SESSION_KEY:key},
  {AWS_ACCESS_KEY_ID:'private-fixture-aws-key'},
  {AWS_CONTAINER_CREDENTIALS_RELATIVE_URI:'/private-fixture-metadata'},
 ])('exits privately rather than admitting app/database/AWS configuration %#',async forbidden=>{
  const exited=Promise.withResolvers<{code:number;stdout:string;stderr:string}>();
  execFile(process.execPath,['--experimental-transform-types','--disable-warning=ExperimentalWarning',fileURLToPath(new URL('../src/hostMain.ts',import.meta.url))],{env:{PATH:process.env['PATH']??'/usr/bin:/bin',FSS_SOCIAL_PUBLISHER_TOKEN:token,...forbidden},timeout:10000,maxBuffer:8192},(error,stdout,stderr)=>{
   exited.resolve({code:typeof error?.code==='number'?error.code:error?1:0,stdout,stderr});
  });
  const result=await exited.promise;
  expect(result.code).toBe(1);expect(result.stdout).toBe('');expect(result.stderr.trim()).toBe('publisher_host_startup_failed');
  expect(result.stderr).not.toMatch(/private-fixture|Bearer|postgresql|cookies/u);
 });
});
