import {it,expect} from 'vitest';
import {createApiClient} from '../src/main/apiClient.ts';
const workspaceId='11111111-1111-4111-8111-111111111111';
const card=(n:number)=>({firmId:`11111111-1111-4111-8111-${String(n).padStart(12,'0')}`,firmName:`PM ${n}`,lane:'new_firm',dueAt:'2026-10-05T00:00:00Z',counts:{replies:0,emailsDue:0,callsDue:0},blockers:[]});
const page=(ids:number[],cursor:string|null,changed=false)=>({status:200,body:{workspaceId,snapshotDate:'2026-10-05',businessTimeZone:'America/New_York',cards:ids.map(card),nextCursor:cursor,orderChanged:changed}});
it('assembles a coherent paginated Today list and keeps cursor metadata out of the offline cache',async()=>{
 const answers=[page([1,2],'first'),page([3],null)];const paths:string[]=[];
 const api=createApiClient({baseUrl:'https://example.test',clientVersion:'1.0.45',send:async url=>{paths.push(url);return answers.shift()!;}});
 const result=await api.today('test');expect(result).toMatchObject({ok:true,value:{cards:[card(1),card(2),card(3)]}});
 expect(paths[1]).toContain('cursor=first');if(result.ok)expect(result.value).not.toHaveProperty('nextCursor');
});
it('replaces partial pages after an order change and refuses a repeating cursor',async()=>{
 const answers=[page([1],'old'),page([2],'new',true),page([3],null)];
 const api=createApiClient({baseUrl:'https://example.test',clientVersion:'1.0.45',send:async()=>answers.shift()!});
 expect(await api.today('test')).toMatchObject({ok:true,value:{cards:[card(2),card(3)]}});
 const broken=createApiClient({baseUrl:'https://example.test',clientVersion:'1.0.45',send:async()=>page([1],'repeat')});
 expect(await broken.today('test')).toMatchObject({ok:false,reason:'invalid_response'});
});
