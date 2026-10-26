import {describe,expect,it} from 'vitest';
import {BROWSER_SECURITY_HEADERS} from '../../src/server/httpPolicy.ts';
import {browserApiPathAllowed,BROWSER_COMMAND_PATHS,BROWSER_VOICE_POST_PATHS} from '../../src/shared/browserContract.ts';
describe('bounded browser call execution policy',()=>{
 it('exposes only existing session reads, explicit start and receipt-only recovery',()=>{
  for(const path of ['/calls/calling','/calls/history','/calling-identities']){
   expect(browserApiPathAllowed('GET',path)).toBe(true);
   expect(browserApiPathAllowed('POST',path)).toBe(false);
  }
  for(const path of ['/calls/session','/calls/access-token','/calling/execution/receipt']){
   expect(browserApiPathAllowed('POST',path)).toBe(true);
   expect(browserApiPathAllowed('GET',path)).toBe(false);
  }
  for(const path of ['/calls/recording','/calls/transcript','/calls/cadence/resume','/calls/stop','/dial/handoff','/calling-identities/register','/calling-identities/disable'])
   for(const method of ['GET','POST'])expect(browserApiPathAllowed(method,path)).toBe(false);
  expect(BROWSER_COMMAND_PATHS).toContain('/calls/session');
  expect(BROWSER_VOICE_POST_PATHS).toEqual(['/calls/access-token']);
 });
 it('keeps scripts local and limits signalling/media to the existing default-edge SDK',()=>{
  const policy=BROWSER_SECURITY_HEADERS['content-security-policy'];
  const directives=new Map(policy.split(';').map(part=>part.trim().split(/\s+/u)).map(([key,...value])=>[key,value]));
  expect(directives.get('script-src')).toEqual(["'self'"]);
  expect(directives.get('connect-src')).toEqual(["'self'",'https://eventgw.twilio.com','wss://voice-js.roaming.twilio.com','https://media.twiliocdn.com','https://sdk.twilio.com']);
  expect(directives.get('media-src')).toEqual(["'self'",'mediastream:','blob:','https://media.twiliocdn.com','https://sdk.twilio.com']);
  expect(policy).not.toMatch(/unsafe-|\*|\bhttp:/u);
  expect(directives.get('frame-ancestors')).toEqual(["'none'"]);
  expect(BROWSER_SECURITY_HEADERS['permissions-policy']).toBe('camera=(), microphone=(self), geolocation=()');
  expect(BROWSER_SECURITY_HEADERS['cache-control']).toBe('private, no-store');
 });
});
