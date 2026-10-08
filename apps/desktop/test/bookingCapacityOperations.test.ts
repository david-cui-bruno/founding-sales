import {expect,it} from 'vitest';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';

const capacity={preference:{weeklyIntroCalls:3,enforcementVerified:false},provider:{status:'unavailable',reason:'api_key_missing',observedAt:null,bookingUrl:'https://cal.com/david/intro',eventTypeId:null,weeklyLimit:null,scope:'event_type'},recorded:{observedAt:'2026-10-08T15:00:00Z',windowStart:'2026-10-01T15:00:00Z',windowEnd:'2026-12-07T15:00:00Z',truncated:false,bookings:[]}};
it('reads booking evidence through the authenticated desktop operation without granting configuration enforcement',async()=>{
 const requests:{url:string;method:string}[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{requests.push({url,method:init.method});return {status:200,body:capacity};}});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','meetings.bookingCapacity',{})).toEqual({capacity});
 expect(requests).toEqual([{url:'https://api.example.test/meetings/booking-capacity',method:'GET'}]);
});
it('drops booking evidence returned after the signed-in identity changes',async()=>{
 let generation=0;
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>{generation++;return {status:200,body:capacity};}});
 const deps={api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','meetings.bookingCapacity',{})).toEqual({capacity:null});
});
