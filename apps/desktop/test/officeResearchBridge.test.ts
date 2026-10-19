import {describe,it,expect} from 'vitest';
import {unevaluatedFirmOfficeAssessment} from '@fss/contracts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {createResearchBridge} from '../src/main/researchBridge.ts';
import {OPERATIONS} from '../src/shared/operations.ts';
const firmId='11111111-1111-4111-8111-111111111111';
function fixture(){
 const calls:{path:string;body:Record<string,unknown>}[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test/',clientVersion:'1.0.28',accessToken:async()=>({token:'local-fixture-token',generation:0}),send:async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body??'{}') as Record<string,unknown>;calls.push({path,body});
  return {status:200,body:path==='/research/firm/run'?{status:'accepted',replayed:false,result:{revision:1,queued:true,purpose:body['purpose']??'brief'}}:{brief:null,facts:[],judgments:null,runs:[],links:[],spend:{todayCents:0,monthToDateCents:0}}};
 }});
 const bridge=createResearchBridge({api,session:{state:async()=>({online:true,mayMutate:true,device:{role:'salesperson'}})}});
 return {bridge,calls};
}
describe('office evidence desktop bridge',()=>{
 it('normalizes old-server absence explicitly and keeps ordinary command bytes purpose-free',async()=>{
  const f=fixture();const view=await f.bridge.open({firmId});expect(view.firm?.officeAssessment).toEqual(unevaluatedFirmOfficeAssessment());
  await f.bridge.run({firmId});const command=f.calls.find(c=>c.path==='/research/firm/run')!;expect(command.body['purpose']).toBeUndefined();
  expect(OPERATIONS['research.run'].input.safeParse({firmId}).success).toBe(true);
 });
 it('sends exactly explicit purpose, uses a separate notice, and forgets all office state',async()=>{
  const f=fixture();await f.bridge.open({firmId});await f.bridge.run({firmId});
  const view=await f.bridge.run({firmId,purpose:'office_evidence'});expect(view.officeNotice).toBe('office_evidence_queued');expect(view.notice).toBe('research_queued');
  expect(f.calls.filter(c=>c.path==='/research/firm/run').map(c=>c.body['purpose'])).toEqual([undefined,'office_evidence']);
  expect(OPERATIONS['research.run'].input.safeParse({firmId,purpose:'office_evidence'}).success).toBe(true);
  expect(OPERATIONS['research.run'].input.safeParse({firmId,purpose:'other'}).success).toBe(false);
  expect(await f.bridge.forget()).toMatchObject({firm:null,officeNotice:null});
 });
});
