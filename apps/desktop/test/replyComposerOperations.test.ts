import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';

const messageId='11111111-1111-4111-8111-111111111111';
const commandId='22222222-2222-4222-8222-222222222222';
it('preserves the explicit human send command identifier and reads original-attempt status through authenticated operations',async()=>{
 const requests:{url:string;body:unknown}[]=[];
 const value={messageId,outboundMessageId:commandId,state:'reconciling',providerMessageId:null,sentAt:null,reason:null};
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{
  requests.push({url,body:JSON.parse(init.body??'{}')});return {status:200,body:url.endsWith('/send')?{status:'accepted',replayed:false,result:{ok:true,value}}:{ok:true,value}};
 }});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 const input={messageId,commandId,text:'Exact reviewed answer.',sourceRevision:'a'.repeat(64),draftRevision:'b'.repeat(64),factRefs:[],envelope:{to:['recipient@example.test'],cc:[]}};
 expect(await answerOperation(operationHandlers(deps),'command','replyComposer.send',input)).toEqual({ok:true,value});
 expect(await answerOperation(operationHandlers(deps),'read','replyComposer.sendStatus',{messageId})).toEqual({ok:true,value});
 expect(requests).toEqual([{url:'https://api.example.test/replies/composer/send',body:{clientVersion:'1.0.49',...input}},{url:'https://api.example.test/replies/composer/send-status',body:{messageId}}]);
});
it('forwards the original human generation command and only the bounded composer endpoint',async()=>{
 const requests:{url:string;body:unknown}[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{
  requests.push({url,body:JSON.parse(init.body??'{}')});
  return {status:200,body:{status:'accepted',replayed:false,result:{ok:false,reason:'generation_unavailable'}}};
 }});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 const input={messageId,commandId,sourceRevision:'a'.repeat(64),factRefs:[],envelope:{to:['recipient@example.test'],cc:[]}};
 expect(await answerOperation(operationHandlers(deps),'command','replyComposer.generate',input)).toEqual({ok:false,reason:'generation_unavailable'});
 expect(requests).toEqual([{url:'https://api.example.test/replies/composer/generate',body:{clientVersion:'1.0.49',...input}}]);
});
it('drops a composer answer that crosses a session identity change',async()=>{
 let generation=0;
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>{
  generation++;
  return {status:200,body:{ok:false,reason:'context_not_available'}};
 }});
 const deps={api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','replyComposer.context',{messageId})).toEqual({ok:false,reason:'not_found'});
});
