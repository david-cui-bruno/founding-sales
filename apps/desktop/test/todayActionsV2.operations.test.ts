import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';
import {operationOf} from '../src/shared/operations.ts';
const id='11111111-1111-4111-8111-111111111111';
const page={version:2,workspaceId:id,businessTimeZone:'America/Chicago',asOf:'2026-10-09T12:00:00.000Z',actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}};
it('reads and opens explicit Today V2 through the authenticated closed host without V1 fallback',async()=>{
 expect(operationOf('today.actionsV2')).toBe('today.actionsV2');
 const requests:{path:string;method:string;body:unknown}[]=[];
 const target={kind:'reply',firmId:id,messageId:id};
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{
  const path=new URL(url).pathname;requests.push({path,method:init.method,body:JSON.parse(init.body??'{}')});
  return {status:200,body:path.endsWith('/open/v2')?{version:2,target}:page};
 }});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','today.actionsV2',{})).toEqual(page);
 expect(await answerOperation(operationHandlers(deps),'read','today.openActionV2',{actionId:`reply-message:${id}`,target})).toEqual({version:2,target});
 expect(requests).toEqual([{path:'/today/actions/v2',method:'GET',body:{}},{path:'/today/actions/open/v2',method:'POST',body:{actionId:`reply-message:${id}`,target}}]);
});
it('drops V2 action labels after signed-in identity drift',async()=>{
 let generation=0;
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>{generation++;return {status:200,body:page};}});
 const deps={api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','today.actionsV2',{})).toBeNull();
});
it.each([404,401,403])('does not fall back to V1 after V2 HTTP %s',async status=>{
 const paths:string[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async url=>{paths.push(new URL(url).pathname);return {status,body:{error:'not_found'}};}});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','today.actionsV2',{})).toBeNull();
 expect(paths).toEqual(['/today/actions/v2']);
});
it('refuses an unexpected cached field rather than publishing a widened action response',async()=>{
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>({status:200,body:{...page,briefing:'withdrawn content'}})});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','today.actionsV2',{})).toBeNull();
});
