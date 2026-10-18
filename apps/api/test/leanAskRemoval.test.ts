import {afterAll,beforeAll,expect,it} from 'vitest';
import {createAuthFixture,type AuthFixture} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {startIntegrationServer,type IntegrationServer} from './support/integrationServer.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';

let fixture:AuthFixture,server:IntegrationServer,token:string;
beforeAll(async()=>{
  fixture=await createAuthFixture();
  token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  server=await startIntegrationServer(fixture);
});
afterAll(async()=>{await server?.close();await fixture?.stop();});

it('does not expose retired answering, history, indexing or answer-derived creation commands',async()=>{
  for(const path of ['/ask/answers/request','/ask/answers/read','/ask/answers/diagnostics','/ask/answers/source/read','/ask/answers/cancel','/ask/answers/investigation/preview','/ask/answers/investigation/commit','/ask/history/list','/ask/history/change','/ask/index/read','/ask/index/request','/ask/purpose/read','/ask/purpose/save','/ask/purpose/activate','/ask/purpose/disable','/ask/sessions/create','/ask/sessions/change','/ask/sessions/turn','/ask/sessions/read','/ask/sessions/list','/ask/actions/create']){
    for(const method of ['GET','POST']){
      const response=await fetch(`${server.origin}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
      expect(response.status,`${method} ${path}`).toBe(404);
    }
  }
});

it('retains authenticated plain record search and historical manual-work reads',async()=>{
  const response=await fetch(`${server.origin}/ask/read`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({operation:'records',kind:'firms',query:'no matching record',limit:20})});
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({operation:'records',records:[],coverage:{semantic:'not_requested'}});
  const work=await fetch(`${server.origin}/ask/actions/read`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});
  expect(work.status).not.toBe(404);
});

it('never registers answering or embedding jobs but retains extraction and ordinary selling',()=>{
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
  expect(registry.get('crm.ask_answer')).toBeUndefined();
  expect(registry.get('crm.ask_index')).toBeUndefined();
  expect(registry.get('sequence.action')).toBeDefined();
  expect(registry.get('reply.human_send')).toBeDefined();
});
