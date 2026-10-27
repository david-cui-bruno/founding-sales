import {describe,expect,it} from 'vitest';
import {browserApiPathAllowed,BROWSER_COMMAND_PATHS,BROWSER_POST_READ_PATHS} from '../../src/shared/browserContract.ts';
describe('private Calling browser boundary',()=>{
 it('allows the five private follow-through operations without generic call writes',()=>{
  const paths=['/calling/wrap',...['list','read','save','receipt'].map(name=>`/calling/follow-ups/${name}`)];
  for(const path of paths){
   expect(browserApiPathAllowed('POST',path)).toBe(true);
   for(const method of ['GET','PUT','DELETE','PATCH','HEAD'])expect(browserApiPathAllowed(method,path)).toBe(false);
   for(const suffix of ['/','/extra','?x=1','/../save','%2fextra'])expect(browserApiPathAllowed('POST',path+suffix)).toBe(false);
  }
  for(const path of ['/calling','/calling/start','/calling/dial','/calling/send','/calling/follow-ups',
   '/calling/follow-ups/publish','/calling/follow-ups/send','/calling/follow-ups/approve','/calling/follow-ups/create',
   '/calls/log','/calls/follow-up','/dial/handoff','/twilio/token','https://other.example/calling/wrap'])
   expect(browserApiPathAllowed('POST',path)).toBe(false);
 });
 it('pins clientVersion only for actual writes and preserves read-only receipt operation',()=>{
  expect(BROWSER_POST_READ_PATHS).toContain('/dial/check');
  expect(BROWSER_COMMAND_PATHS).not.toContain('/dial/check');
  expect(BROWSER_COMMAND_PATHS).toContain('/calling/wrap');
  expect(BROWSER_COMMAND_PATHS).toContain('/calling/follow-ups/save');
  for(const name of ['list','read','receipt']){
   expect(BROWSER_POST_READ_PATHS).toContain(`/calling/follow-ups/${name}`);
   expect(BROWSER_COMMAND_PATHS).not.toContain(`/calling/follow-ups/${name}`);
  }
 });
});
