import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {captureProspectPhonePages} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import {parsePageText} from '@fss/domain/research/pageText.ts';
import type {PageFetchResult} from '@fss/domain/research/providers.ts';
const website='https://supply.example.test/';
const now=Date.parse('2026-10-27T01:00:00.000Z');
function page(text:string,path='contact',contentType='text/html'):PageFetchResult['pages'][number]{
 const body=new TextEncoder().encode(text);
 return {url:website+path,body,contentType,contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date(now-1000).toISOString(),firstParty:true};
}
const capture=(pages:PageFetchResult['pages'])=>captureProspectPhonePages(pages,website,4,1000000,now);
it('preserves the exact parsed whole blocks, body bytes, captured hash, URL and retrieval time',()=>{
 const original=page('<p>Office phone: (214) 555-0123</p><p>Main phone: 214-555-0124</p>');
 const bytes=Buffer.from(original.body),parsed=parsePageText(original.body,original.contentType,{omitNavigation:true,includeArticles:true});
 const result=capture([original]);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
 expect(result.value[0]).toMatchObject({url:original.url,contentHash:original.contentHash,retrievedAt:original.retrievedAt,blocks:parsed.blocks,truncated:false});
 expect(result.value[0]!.relevantTextHash).toBe(createHash('sha256').update(JSON.stringify(parsed.blocks)).digest('hex'));
 expect(Buffer.from(original.body)).toEqual(bytes);
});
it.each([
 ['single oversized block',`<p>${'a'.repeat(4001)}</p>`,false],
 ['block count',Array.from({length:101},(_,index)=>`<p>Published text ${index}</p>`).join(''),true],
 ['character total',Array.from({length:4},()=>`<p>${'a'.repeat(3000)}</p>`).join(''),true],
] as const)('reproduces whole-capture refusal for %s despite a useful successful contact page',(_name,html,truncated)=>{
 const phone=page('<p>Office phone: 214-555-0123</p>');
 const other=page(html,'about');
 expect(parsePageText(other.body,other.contentType,{omitNavigation:true,includeArticles:true}).truncated).toBe(truncated);
 expect(capture([phone]).ok).toBe(true);
 const failed=capture([phone,other]);expect(failed).toEqual({ok:false,reason:'bounded_capture_incomplete'});
 expect(failed).not.toHaveProperty('value');
});
it('keeps the 4000-character block boundary rather than splitting or accepting a prefix',()=>{
 const accepted=page(`<p>${'a'.repeat(4000)}</p>`),rejected=page(`<p>${'a'.repeat(4001)}</p>`);
 const result=capture([accepted]);expect(result.ok).toBe(true);
 if(result.ok)expect(result.value[0]!.blocks).toEqual([{id:'b1',text:'a'.repeat(4000)}]);
 expect(capture([rejected])).toEqual({ok:false,reason:'bounded_capture_incomplete'});
});
it('does not recover a survivor after exact source association, future timestamp, duplicate URL or byte budget failure',()=>{
 const phone=page('<p>Office phone: 214-555-0123</p>');
 expect(capture([phone,{...page('<p>Other</p>','about'),firstParty:false}])).toEqual({ok:false,reason:'source_not_permitted'});
 expect(capture([phone,{...page('<p>Other</p>','about'),url:'https://different.example.test/'}])).toEqual({ok:false,reason:'source_not_permitted'});
 expect(capture([phone,{...page('<p>Other</p>','about'),retrievedAt:new Date(now+1).toISOString()}])).toEqual({ok:false,reason:'source_unavailable'});
 expect(capture([phone,phone])).toEqual({ok:false,reason:'bounded_capture_incomplete'});
 expect(captureProspectPhonePages([phone],website,4,phone.body.byteLength-1,now)).toEqual({ok:false,reason:'bounded_capture_incomplete'});
 expect(captureProspectPhonePages([phone],website,0,1000000,now)).toEqual({ok:false,reason:'bounded_capture_incomplete'});
});
it('retains existing intentional navigation/form omissions rather than claiming all published page text was captured',()=>{
 const input=page('<nav><p>Phone: 214-555-0124</p></nav><form><p>Phone</p></form><p>Office phone: 214-555-0123</p>');
 const result=capture([input]);expect(result.ok).toBe(true);
 if(result.ok)expect(result.value[0]!.blocks).toEqual([{id:'b1',text:'Office phone: 214-555-0123'}]);
});
