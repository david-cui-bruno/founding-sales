import {describe,expect,it} from 'vitest';
import {calcomCapacityClient} from '../src/integrations/calcomCapacityClient.ts';
describe('read-only Cal.com capacity transport',()=>{
  it('uses authenticated GET reads with the documented event API version, exact link filters and no redirect credential forwarding',async()=>{
    const requests:{url:string;method:string;version:string|undefined;redirect:string}[]=[];
    const client=calcomCapacityClient({apiKey:'cal_synthetic_capacity_key',http:async(url,init)=>{
      requests.push({url,method:init.method,version:init.headers['cal-api-version'],redirect:init.redirect});
      expect(init.headers['authorization']).toBe('Bearer cal_synthetic_capacity_key');
      return Response.json({status:'success',data:url.endsWith('/me')?{id:42,username:'callie-founder'}:[{id:73}]});
    }});
    expect(await client.readProfile()).toMatchObject({id:42});
    expect(await client.readEventTypes({username:'callie-founder',eventSlug:'intro'})).toEqual([{id:73}]);
    expect(requests).toEqual([
      {url:'https://api.cal.com/v2/me',method:'GET',version:undefined,redirect:'error'},
      {url:'https://api.cal.com/v2/event-types?username=callie-founder&eventSlug=intro',method:'GET',version:'2026-06-12',redirect:'error'},
    ]);
  });
  it.each([[401,'provider_unauthorized'],[403,'provider_forbidden'],[429,'provider_rate_limited'],[500,'provider_unreachable']] as const)('reports HTTP %s only as %s and never exposes provider prose',async(status,code)=>{
    const client=calcomCapacityClient({apiKey:'cal_synthetic_capacity_key',http:async()=>Response.json({message:'secret provider debug context'}, {status})});
    await expect(client.readProfile()).rejects.toThrow(new Error(code));
  });

  it.each([
    {label:'an error envelope',response:()=>Response.json({status:'error',data:[{id:73}]})},
    {label:'an event answer that is not a list',response:()=>Response.json({status:'success',data:{id:73}})},
    {label:'an oversized answer',response:()=>Response.json({status:'success',data:[{id:73,description:'x'.repeat(140000)}]})},
    {label:'a malformed JSON body',response:()=>new Response('not json',{status:200})},
  ])('refuses $label as coded metadata only',async({response})=>{
    const client=calcomCapacityClient({apiKey:'cal_synthetic_capacity_key',http:async()=>response()});
    await expect(client.readEventTypes({username:'callie-founder',eventSlug:'intro'})).rejects.toThrow(new Error('provider_invalid_response'));
  });

});
