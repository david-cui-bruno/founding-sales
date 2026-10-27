import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {manualProspectPhoneEvidenceSchema,sourceObservationSchema} from '@fss/contracts';
import {parsePageText,blocksFromPlainText} from '../../research/pageText.ts';
import {captureProspectPhonePages} from '../../sourcing/prospectPhoneDiscovery.ts';
import {projectProspectPhoneDiscovery,composeProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscoveryProjection.ts';
import {scanManualLiteralPhones,type LiteralInput} from '../../sourcing/manualProspectLiteralPhone.ts';
import {PHONE_SUPPLY_RUN as runId,PHONE_SUPPLY_NOW as now,PHONE_SUPPLY_SITE as website,phoneSupplyPage as page,phoneSupplyObservation as observation,phoneSupplyRun as run,phoneSupplyHtml as html} from './phoneSupplyFixtures.ts';
const capture=(texts:string[])=>captureProspectPhonePages([page(html(texts))],website,4,1000000,now);
const profile={omitNavigation:true,includeArticles:true,profile:'phone_discovery'} as const;
function scanInput(texts:string[]):LiteralInput{
 const source=observation(texts);
 return {runId,observations:[source],website,authorities:{[source.id]:{kind:'phone_discovery',runId,expiresAt:new Date(now+60000).toISOString()}},lineage:{kind:'provider_original'},now};
}
it('keeps 256 whole ordered blocks but refuses 257 without a surviving observation',()=>{
 const texts=Array.from({length:256},(_,index)=>`Published block ${index}`);
 const result=capture(texts);expect(result.ok).toBe(true);
 if(result.ok)expect(result.value[0]!.blocks).toEqual(texts.map((text,index)=>({id:`b${index+1}`,text})));
 expect(capture([...texts,'Office phone: 214-555-0123'])).toEqual({ok:false,reason:'bounded_capture_incomplete'});
});
it.each(['a'.repeat(16000),'🏠'.repeat(8000)])('retains whole 16000-UTF16-unit block, refusing one unit over',text=>{
 const result=capture([text]);expect(result.ok).toBe(true);
 if(result.ok)expect(result.value[0]!.blocks).toEqual([{id:'b1',text}]);
 expect(capture(['Office phone: 214-555-0123',text+'a'])).toEqual({ok:false,reason:'bounded_capture_incomplete'});
});
it('counts two separator units per block toward exactly 50000 page characters',()=>{
 const texts=['a'.repeat(16000),'b'.repeat(16000),'c'.repeat(16000),'d'.repeat(1994)];
 const input=page(html(texts)),parsed=parsePageText(input.body,input.contentType,profile);
 expect(parsed.truncated).toBe(false);expect(parsed.text.length).toBe(50000);expect(capture(texts).ok).toBe(true);
 expect(capture([...texts.slice(0,3),texts[3]+'e'])).toEqual({ok:false,reason:'bounded_capture_incomplete'});
});
it('retains full page hashes and body without splitting, merging or rewriting block boundaries',()=>{
 const texts=['a'.repeat(4100)+' Office phone: 214-555-0123',...Array.from({length:101},(_,index)=>`Published ${index}`)];
 const input=page(html(texts)),bytes=Buffer.from(input.body),result=captureProspectPhonePages([input],website,4,1000000,now);
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
 const source=result.value[0]!;
 expect(source.blocks).toEqual(texts.map((text,index)=>({id:`b${index+1}`,text})));
 expect(source.contentHash).toBe(input.contentHash);expect(Buffer.from(input.body)).toEqual(bytes);
 expect(source.relevantTextHash).toBe(createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex'));
 const projected=manualProspectPhoneEvidenceSchema.parse(projectProspectPhoneDiscovery(run(result.value),now));
 expect(projected).toMatchObject({state:'observed',value:'+12145550123',coverage:{state:'complete',blocks:102},sources:[{labelStart:4101,start:4115,blockId:'b1'}]});
});
it.each(['Fax','Personal phone','Mobile','vendor','powered by'])('does not detach %s context elsewhere in a long whole block',label=>{
 const text=`${label} ${'a'.repeat(4100)} Office phone: 214-555-0123`,result=capture([text]);
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
 expect(result.value[0]!.blocks).toEqual([{id:'b1',text}]);
 const projected=manualProspectPhoneEvidenceSchema.parse(projectProspectPhoneDiscovery(run(result.value),now));
 expect(projected).toMatchObject({state:'conflicting',sources:[{normalizedValue:null}],coverage:{state:'complete'}});
 expect(projected).not.toHaveProperty('value');
});
it('refuses changed hash, unsafe first-party association, truncated source and future retrieval instead of choosing a survivor',()=>{
 const input=scanInput(['a'.repeat(4100)+' Phone: 214-555-0123']),source=(input.observations as ReturnType<typeof observation>[])[0]!;
 for(const change of [{relevantTextHash:'b'.repeat(64)},{url:'https://other.example.test/'},{firstParty:false},{truncated:true},{retrievedAt:new Date(now+1).toISOString()}]){
  const result=scanManualLiteralPhones({...input,observations:[{...source,...change}]});
  expect(result).toMatchObject({sources:[],reason:'original_not_usable',coverage:{state:'unavailable'}});
 }
});
it('allows larger scanning only with one current matching trusted phone run, never retained authority or caller shape',()=>{
 const input=scanInput(['a'.repeat(4100)+' Phone: 214-555-0123']),source=(input.observations as ReturnType<typeof observation>[])[0]!;
 expect(scanManualLiteralPhones(input)).toMatchObject({unresolved:false,sources:[{normalizedValue:'+12145550123'}]});
 const authorities:LiteralInput['authorities'][]=[{},
  {[source.id]:{kind:'candidate_source',sourceUrl:source.url}},
  {[source.id]:{kind:'retained_evidence',evidenceId:runId}},
  {[source.id]:{kind:'phone_discovery',runId:source.id,expiresAt:new Date(now+60000).toISOString()}},
  {[source.id]:{kind:'phone_discovery',runId,expiresAt:new Date(now).toISOString()}},
 ];
 for(const authority of authorities)expect(scanManualLiteralPhones({...input,authorities:authority})).toMatchObject({sources:[],reason:'original_not_usable'});
 expect(scanManualLiteralPhones({...input,lineage:{kind:'retained_interpretation',decisionId:runId,originalRunId:runId,originalRevision:1,resultRevision:2}})).toMatchObject({sources:[],reason:'original_not_usable'});
 const other=observation(['Phone: 214-555-0124'],3);
 expect(scanManualLiteralPhones({...input,observations:[source,other],authorities:{...input.authorities,[other.id]:{kind:'candidate_source',sourceUrl:other.url}}})).toMatchObject({sources:[],reason:'original_not_usable'});
});
it('limits trusted phone runs to four observations and coverage to 1024 blocks',()=>{
 const observations=Array.from({length:4},(_,index)=>observation(Array.from({length:256},()=> 'Published text'),index+2));
 const input:LiteralInput={runId,observations,website,authorities:Object.fromEntries(observations.map(source=>[source.id,{kind:'phone_discovery',runId,expiresAt:new Date(now+60000).toISOString()}])),lineage:{kind:'provider_original'},now};
 expect(scanManualLiteralPhones(input)).toMatchObject({sources:[],unresolved:false,coverage:{state:'complete',observations:4,blocks:1024}});
 const extra=observation(['Phone: 214-555-0123'],6);
 expect(scanManualLiteralPhones({...input,observations:[...observations,extra],authorities:{...input.authorities,[extra.id]:{kind:'phone_discovery',runId,expiresAt:new Date(now+60000).toISOString()}}})).toMatchObject({sources:[],reason:'bounded_scan_incomplete'});
});
it('keeps default parser and nonphone retained-observation capacities unchanged',()=>{
 const hundred=Array.from({length:100},()=> 'Published text');
 const defaults=page(html([...hundred,'Office phone: 214-555-0123']));
 const parsed=parsePageText(defaults.body,defaults.contentType);
 expect(parsed.truncated).toBe(true);expect(parsed.blocks).toHaveLength(100);
 const plain=blocksFromPlainText([...hundred,'Office phone: 214-555-0123'].join('\n'));
 expect(plain.truncated).toBe(true);expect(plain.blocks).toHaveLength(100);
 const long=page(html(['a'.repeat(12001)]));expect(parsePageText(long.body,long.contentType)).toEqual({blocks:[],text:'',truncated:true});
 const fourK=page(html(['a'.repeat(4001)]));expect(parsePageText(fourK.body,fourK.contentType)).toEqual({blocks:[{id:'b1',text:'a'.repeat(4001)}],text:'a'.repeat(4001),truncated:false});
 const smallPage=page('<nav>Navigation</nav><p>Office phone: 214-555-0123</p><article>Published &amp; exact</article><script>never prose</script>');
 expect(parsePageText(smallPage.body,smallPage.contentType,profile)).toEqual(parsePageText(smallPage.body,smallPage.contentType,{omitNavigation:true,includeArticles:true}));
 expect(sourceObservationSchema.safeParse(observation(['a'.repeat(4001)])).success).toBe(false);
 expect(sourceObservationSchema.safeParse(observation([...hundred,'Extra'])).success).toBe(false);
 const small=observation(['Phone: 214-555-0123']);
 const scan=scanManualLiteralPhones({runId,observations:[small],website,authorities:{[small.id]:{kind:'candidate_source',sourceUrl:small.url}},lineage:{kind:'provider_original'},now});
 expect(scan).toMatchObject({unresolved:false,sources:[{normalizedValue:'+12145550123'}],coverage:{state:'complete'}});
});
it('still refuses entire aggregate bytes, page count, source failure and current lower byte/page budget',()=>{
 const texts=['a'.repeat(16000),'b'.repeat(16000),'c'.repeat(12000)],first=page(html(texts)),second=page(html(texts),'about'),third=page(html(texts),'team');
 expect(captureProspectPhonePages([first,second],website,4,1000000,now).ok).toBe(true);
 expect(captureProspectPhonePages([first,second,third],website,4,1000000,now)).toEqual({ok:false,reason:'bounded_capture_incomplete'});
 expect(captureProspectPhonePages([first,second],website,1,1000000,now)).toEqual({ok:false,reason:'bounded_capture_incomplete'});
 expect(captureProspectPhonePages([first],website,4,first.body.byteLength-1,now)).toEqual({ok:false,reason:'bounded_capture_incomplete'});
 expect(captureProspectPhonePages([first,{...second,firstParty:false}],website,4,1000000,now)).toEqual({ok:false,reason:'source_not_permitted'});
});
it('retains conflict policy and expired/lost-source no-survivor composition for larger complete observations',()=>{
 const complete=projectProspectPhoneDiscovery(run([observation(['a'.repeat(4100)+' Phone: 214-555-0123','Phone: 214-555-0124'])]),now);
 expect(complete).toMatchObject({state:'conflicting',reason:'multiple_retained_numbers'});expect(complete).not.toHaveProperty('value');
 const legacy=manualProspectPhoneEvidenceSchema.parse({state:'observed',value:'+12145550123',sources:[{runId,observationId:runId,blockId:'legacy',url:website,retrievedAt:new Date(now-1000).toISOString()}]});
 const bounded=projectProspectPhoneDiscovery(run([observation(['a'.repeat(16001)])]),now);
 expect(composeProspectPhoneDiscovery(legacy,bounded)).toMatchObject({state:'not_extracted'});
 const expired=run([observation(['a'.repeat(4100)+' Phone: 214-555-0123'])]);expired.expires_at=new Date(now);
 expect(composeProspectPhoneDiscovery(legacy,projectProspectPhoneDiscovery(expired,now))).toMatchObject({state:'not_extracted'});
});
