import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {manualProspectPhoneEvidenceSchema,type ManualProspect} from '@fss/contracts';
import {captureProspectPhonePages} from '../../sourcing/prospectPhoneDiscovery.ts';
import {projectProspectPhoneDiscovery,composeProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscoveryProjection.ts';
import type {PhoneDiscoveryRun} from '../../sourcing/prospectPhoneDiscoveryStore.ts';
import type {FetchedPage} from '../../research/providers.ts';
const now=Date.parse('2026-10-26T06:00:00.000Z');
function page(text='Office phone: (214) 555-0123'):FetchedPage{return {url:'https://example.test/contact',contentHash:'a'.repeat(64),body:new TextEncoder().encode(text),contentType:'text/plain',firstParty:true,retrievedAt:new Date(now-1000).toISOString()};}
function run(text?:string):PhoneDiscoveryRun{
 const captured=captureProspectPhonePages([page(text)],'https://example.test/',4,1000000,now);if(!captured.ok)throw Error(captured.reason);
 return {id:randomUUID(),candidate_id:randomUUID(),candidate_revision:1,creator_user_id:randomUUID(),creator_ref:randomUUID(),method:'company-public-phone-v1',state:'complete',reason:null,
  requested_at:new Date(now-2000),deadline_at:new Date(now+60000),checked_at:new Date(now),expires_at:new Date(now+86400000),dispatched_at:new Date(now-1500),dispatch_finished_at:new Date(now),
  content:{website:'https://example.test/',sourceUrls:['https://directory.example.test/retained'],observations:captured.value}};
}
it('reuses literal normalization and preserves exact new temporary authority without qualification lineage',()=>{
 const r=run(),e=projectProspectPhoneDiscovery(r,now);
 expect(e).toMatchObject({state:'observed',value:'+12145550123',sources:[{runId:r.id,literal:'(214) 555-0123',authority:{kind:'phone_discovery',runId:r.id,expiresAt:r.expires_at.toISOString()},lineage:{kind:'provider_original'}}]});
 expect(manualProspectPhoneEvidenceSchema.safeParse(e).success).toBe(true);
});
it.each(['Fax: (214) 555-0123','Mobile: (214) 555-0123','Office phone: 1-800-FLOWERS','Office phone: (214) 555-0123 ext 9','Office phone: (214) 555-0123 or (214) 555-0124'])('does not select unsupported or conflicting %s',text=>{
 expect(projectProspectPhoneDiscovery(run(text),now).state).toBe('conflicting');
});
it('no label/no literal means not extracted rather than absence',()=>{
 expect(projectProspectPhoneDiscovery(run('Manager office contact details'),now)).toMatchObject({state:'not_extracted',coverage:{state:'complete'}});
});
it('expired, pending, unavailable and erased results never return a phone',()=>{
 for(const state of ['pending','running','unavailable'] as const){const r=run();r.state=state;expect(projectProspectPhoneDiscovery(r,now).state).toBe('not_extracted');}
 const r=run();expect(projectProspectPhoneDiscovery(r,r.expires_at.getTime()).state).toBe('not_extracted');r.content=null;expect(projectProspectPhoneDiscovery(r,now).state).toBe('not_extracted');
});
it.each(['foreign','third_party','oversize','future','unreadable','truncated'] as const)('refuses an entire capture rather than a surviving prefix: %s',mode=>{
 let bad=page();
 if(mode==='foreign')bad={...bad,url:'https://foreign.example.test/contact'};
 if(mode==='third_party')bad={...bad,firstParty:false};
 if(mode==='oversize')bad={...bad,body:new Uint8Array(1000001)};
 if(mode==='future')bad={...bad,retrievedAt:new Date(now+1).toISOString()};
 if(mode==='unreadable')bad={...bad,contentType:'application/octet-stream'};
 if(mode==='truncated')bad={...bad,body:new TextEncoder().encode(Array.from({length:101},(_,i)=>`Phone ${i}`).join('\n'))};
 expect(captureProspectPhonePages([{...page(),url:'https://example.test/'},bad],'https://example.test/',4,1000000,now).ok).toBe(false);
});
it('duplicate page URLs, excessive pages and input bytes are not selected-prefix winners',()=>{
 expect(captureProspectPhonePages([page(),page()],'https://example.test/',4,1000000,now).ok).toBe(false);
 expect(captureProspectPhonePages([page(),page()],'https://example.test/',1,1000000,now).ok).toBe(false);
 expect(captureProspectPhonePages([page()],'https://example.test/',4,4,now).ok).toBe(false);
});
it('keeps both normalized sources for matching numbers and refuses competing sources',()=>{
 const a=projectProspectPhoneDiscovery(run(),now),b=projectProspectPhoneDiscovery(run(),now),other=projectProspectPhoneDiscovery(run('Office phone: (214) 555-0124'),now);
 const same=composeProspectPhoneDiscovery(a,b);expect(same).toMatchObject({state:'observed',value:'+12145550123',sources:[{},{}]});expect(manualProspectPhoneEvidenceSchema.safeParse(same).success).toBe(true);
 expect(composeProspectPhoneDiscovery(a,other).state).toBe('conflicting');
});
it('missing operation preserves legacy while lost or changed dependencies cannot select a survivor',()=>{
 const a=projectProspectPhoneDiscovery(run(),now),missing:NonNullable<ManualProspect['phoneEvidence']>={state:'not_extracted',reason:'no_current_permitted_phone_evidence'};
 expect(composeProspectPhoneDiscovery(a,null)).toEqual(a);
 expect(composeProspectPhoneDiscovery(missing,a)).toEqual(a);
 expect(composeProspectPhoneDiscovery(a,missing).state).toBe('not_extracted');
 const changed:NonNullable<ManualProspect['phoneEvidence']>={state:'not_extracted',reason:'optional_source_changed',coverage:{parser:'manual-literal-phone-v1',state:'changed',observations:0,blocks:0}};
 expect(composeProspectPhoneDiscovery(changed,a)).toEqual(changed);
 const conflicting=projectProspectPhoneDiscovery(run('Phone: (214) 555-0123 or (214) 555-0124'),now);
 expect(composeProspectPhoneDiscovery(a,conflicting).state).toBe('conflicting');
});
