import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
import {operationOf} from '../src/shared/operations.ts';
const id='11111111-1111-4111-8111-111111111111';
const source={workspaceId:id,sourceId:id,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null};
const target={source,claimId:id,claimRevision:1,claimHash:'b'.repeat(64),contextHash:'c'.repeat(64),expectedDecisionRevision:0};
const review={...target,expectedCommitmentRevision:0,classification:'internal_promise',actor:'self',actionLabel:'Prepare the summary',due:{kind:'date',date:'2026-10-12',zone:'America/Chicago',expression:'by October 12'}};
it('uses registered authenticated commitment review, status, read, history and explicit completion operations',async()=>{
 expect(operationOf('crm.commitmentsReviewStatus')).toBe('crm.commitmentsReviewStatus');
 const requests:{path:string;method:string;body:unknown}[]=[];
 const bodies:Record<string,unknown>={
  '/crm/commitments/review/status':{current:null},
  '/crm/commitments/review':{status:'accepted',result:{commitmentId:id,revision:1,status:'queued'}},
  '/crm/commitments/read':{items:[],nextAfterId:null},
  '/crm/commitments/complete':{status:'accepted',result:{taskId:id,version:2,completedAt:'2026-10-09T12:00:00.000Z'}},
 };
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{
  const path=new URL(url).pathname;requests.push({path,method:init.method,body:JSON.parse(init.body??'{}')});return {status:200,body:bodies[path]};
 }});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 const handlers=operationHandlers(deps);
 expect(await answerOperation(handlers,'read','crm.commitmentsReviewStatus',target)).toEqual({current:null});
 expect(await answerOperation(handlers,'command','crm.commitmentsReview',review)).toEqual({commitmentId:id,revision:1,status:'queued'});
 expect(await answerOperation(handlers,'read','crm.commitmentsRead',{scope:{kind:'source',sourceId:id,sourceKind:'selected_note'},limit:50})).toEqual({items:[],nextAfterId:null});
 expect(await answerOperation(handlers,'read','crm.commitmentsHistory',{limit:50})).toEqual({items:[],nextAfterId:null});
 expect(await answerOperation(handlers,'command','crm.commitmentsComplete',{taskId:id,expectedVersion:1})).toEqual({taskId:id,version:2,completedAt:'2026-10-09T12:00:00.000Z'});
 expect(requests.map(request=>request.path)).toEqual(['/crm/commitments/review/status','/crm/commitments/review','/crm/commitments/read','/crm/commitments/read','/crm/commitments/complete']);
 expect(requests[1]!.body).toMatchObject({...review,commandId:expect.any(String),clientVersion:'1.0.49'});
 expect(requests[3]!.body).toEqual({scope:{kind:'history'},limit:50});
});
it.each(['malformed','denied','identity'] as const)('refuses private commitment status after %s without fallback',async failure=>{
 let generation=0;const paths:string[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async url=>{
  paths.push(new URL(url).pathname);if(failure==='identity')generation++;
  return {status:failure==='denied'?403:200,body:failure==='malformed'?{current:null,privateQuote:'not allowed'}:{current:null}};
 }});
 const deps={api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps;
 await expect(answerOperation(operationHandlers(deps),'read','crm.commitmentsReviewStatus',target)).rejects.toThrow();
 expect(paths).toEqual(['/crm/commitments/review/status']);
});
