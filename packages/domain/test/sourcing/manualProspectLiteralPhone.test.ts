import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {manualProspectPhoneEvidenceSchema} from '@fss/contracts';
import {scanManualLiteralPhones,type LiteralInput} from '../../sourcing/manualProspectLiteralPhone.ts';
import {projectManualPhone,type ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {originalAuthorities,originalLineage} from '../../sourcing/manualProspectOriginalAuthority.ts';
import {projectManualProspect} from '../../sourcing/manualProspectProjection.ts';
import {manualPhoneFixture} from './support/manualPhoneFixture.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from './support/manualProspectFixture.ts';
function input(texts=['Phone: (214) 555-0123']):LiteralInput {
 const e=manualPhoneFixture('https://source.example.test/phone',texts),source=e.observations[0]!;source.firstParty=true;
 return {runId:randomUUID(),observations:e.observations,website:'https://source.example.test/',authorities:{[source.id]:{kind:'candidate_source',sourceUrl:source.url}},lineage:{kind:'provider_original'},now:Date.now()};
}
function snapshot(texts=['Phone: (214) 555-0123']):ManualPhoneSnapshot {
 const candidate=manualOrdinaryFixture(775),i=input(texts),observations=i.observations as ReturnType<typeof manualPhoneFixture>['observations'];
 candidate.sourceUrl=observations[0]!.url;candidate.website='https://source.example.test/';
 return {id:i.runId,candidate_id:randomUUID(),candidate_revision:1,observations,facts:[],permitted_urls:[candidate.sourceUrl],payload:candidate};
}
it('extracts exact literal and label UTF16 spans from originals without phone facts',()=>{
 const i=input(['🏡 Main phone: (214) 555-0123']),result=scanManualLiteralPhones(i),source=result.sources[0]!;
 expect(result).toMatchObject({coverage:{state:'complete',observations:1,blocks:1},unresolved:false});
 expect(source).toMatchObject({literal:'(214) 555-0123',normalizedValue:'+12145550123',normalizationBasis:'default_us',label:'Main phone',start:15});
 const block=(i.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!.blocks[0]!;
 expect(block.text.slice(source.start,source.end)).toBe(source.literal);expect(block.text.slice(source.labelStart,source.labelEnd)).toBe(source.label);
 expect(manualProspectPhoneEvidenceSchema.safeParse({state:'observed',value:source.normalizedValue,sources:result.sources,coverage:result.coverage}).success).toBe(true);
});
it.each(['Phone +44 20 7946 0958','Tel: 214.555.0123','Telephone: 1-214-555-0123','Call us at (214) 555-0123'])('supports reviewed whole numeric grammar: %s',text=>{
 const r=scanManualLiteralPhones(input([text]));expect(r.unresolved).toBe(false);expect(r.sources).toHaveLength(1);expect(r.sources[0]?.normalizedValue).not.toBeNull();
});
it.each(['Phone: 555-0123','Phone: 1-800-FLOWERS','Phone: 2145550123 ext 45','Phone: 2145550123x45','Fax: 2145550123','Mobile phone: 2145550123','Personal: 2145550123','Emergency: 2145550123','Phone: 2145550123 vendor support','Phone: 99999999999999999999999'])('keeps unsupported or contextual ambiguity without selecting prefix: %s',text=>{
 const r=scanManualLiteralPhones(input([text]));expect(r.unresolved).toBe(true);expect(r.sources.every(source=>source.normalizedValue===null)).toBe(true);
 expect(projectManualPhone(snapshot([text]))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal'});
});
it('does not lose unsupported alternate beside a supported number or coerce no-match to absence',()=>{
 expect(projectManualPhone(snapshot(['Phone 2145550123','Tel 555-0123']))).toMatchObject({state:'conflicting'});
 expect(projectManualPhone(snapshot(['No endpoint retained']))).toMatchObject({state:'not_extracted',reason:'retained_text_not_extracted',coverage:{state:'complete'}});
 expect(scanManualLiteralPhones(input(['Unlabelled 2145550123'])).sources).toEqual([]);
});
it.each(['Our team brings a personal touch to every building.','Residents appreciate our PERSONAL\nTOUCH and attentive service.'])('does not classify digit-free personal-touch prose as a phone label: %s',text=>{
 expect(scanManualLiteralPhones(input([text]))).toMatchObject({sources:[],unresolved:false,coverage:{state:'complete'}});
 expect(projectManualPhone(snapshot([text]))).toMatchObject({state:'not_extracted',reason:'retained_text_not_extracted'});
 // Independent valid evidence remains necessary, and attachment stays in its own block.
 expect(projectManualPhone(snapshot([text,'Office phone: 2145550123']))).toMatchObject({state:'observed',value:'+12145550123',sources:[{label:'Office phone'}]});
});
it.each([
 'Personal: unavailable', 'Personal phone: unavailable', 'Personal phone: 2145550123',
 'Personal: 2145550123', 'Personal touch: 2145550123', 'Our personal touch serves 2 buildings.',
 'Our personal touch serves ２ buildings.', 'Personal touchstone unavailable',
 'Personal: touch unavailable', 'Mobile: unavailable', 'Fax: unavailable',
 'Our personal touch. Personal phone: unavailable',
 'Our personal touch. Mobile: unavailable', 'Our personal touch. Fax: unavailable',
])('preserves unresolved phone labels and numbered personal ambiguity: %s',text=>{
 expect(scanManualLiteralPhones(input([text])).unresolved).toBe(true);
 expect(projectManualPhone(snapshot([text,'Office phone: 2145550123']))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal'});
});
it('does not attach a number from another block after digit-free personal-touch prose',()=>{
 expect(scanManualLiteralPhones(input(['Our personal touch matters.','2145550123']))).toMatchObject({sources:[],unresolved:false});
 expect(projectManualPhone(snapshot(['Our personal touch matters.','2145550123']))).toMatchObject({state:'not_extracted'});
 expect(projectManualPhone(snapshot(['Phone office','2145550123']))).toMatchObject({state:'conflicting'});
});
it.each([
 ['Phone: 2145550123 / ２１４５５５０１２４','２１４５５５０１２４'],
 ['Phone: 2145550123 / ٢١٤٥٥٥٠١٢٤','٢١٤٥٥٥٠١٢٤'],
 ['Phone: (214) 555-0123-FLOWERS','(214) 555-0123-FLOWERS'],
 ['Phone: 2145550123 / (214) 555-0124-FLOWERS','(214) 555-0124-FLOWERS'],
])('SPEC F1 refuses unsupported whole literal instead of selecting a prefix: %s',(text,literal)=>{
 const result=scanManualLiteralPhones(input([text]));expect(result.unresolved).toBe(true);
 expect(result.sources).toContainEqual(expect.objectContaining({literal,normalizedValue:null,normalizationBasis:'unsupported'}));
 for(const source of result.sources)expect(text.slice(source.start,source.end)).toBe(source.literal);
 expect(projectManualPhone(snapshot([text]))).toMatchObject({state:'conflicting',reason:'unresolved_retained_literal'});
});
it.each(['Phone: unavailable\nCompany registration: 2145550123','Phone: N/A\nOrder ID: 2145550123','Phone:\nRegistration: 2145550123'])('SPEC F2 never borrows unrelated field numbers: %s',text=>{
 const result=scanManualLiteralPhones(input([text]));expect(result.unresolved).toBe(true);expect(result.sources).toEqual([]);
 const evidence=projectManualPhone(snapshot([text]));expect(['not_extracted','conflicting']).toContain(evidence.state);
});
it.each(['Phone:\n(214) 555-0123','Call us at (214) 555-0123','Phone: 2145550123 / +1 214 555 0123','Phone: 2145550123; (214) 555-0123'])('SPEC finite attachment grammar preserves supported forms: %s',text=>{
 const result=scanManualLiteralPhones(input([text]));expect(result.unresolved).toBe(false);expect(projectManualPhone(snapshot([text]))).toMatchObject({state:'observed',value:'+12145550123'});
 for(const source of result.sources)expect(text.slice(source.start,source.end)).toBe(source.literal);
});
it.each([
 ['Phone: 2145550123 ext ４５','2145550123 ext ４５'],
 ['Phone: 2145550123 ext. SALES','2145550123 ext. SALES'],
 ['Phone: 2145550123 or ８００５５５０１９９','８００５５５０１９９'],
 ['Phone: 2145550123 or ２１４５５５０１２４','２１４５５５０１２４'],
 ['Phone: 2145550123 or 8005550199 ext ４５','8005550199 ext ４５'],
])('RISK R1 STANDARDS S1 retains whole unsupported forms even under explicit raw absence: %s',(text,literal)=>{
 const scan=scanManualLiteralPhones(input([text]));expect(scan.unresolved).toBe(true);
 expect(scan.sources).toContainEqual(expect.objectContaining({literal,normalizedValue:null}));
 for(const source of scan.sources)expect(text.slice(source.start,source.end)).toBe(source.literal);
 const phone=projectManualPhone(snapshot([text]));expect(phone.state).toBe('conflicting');
 const fixture=manualDiscoveryFixture(),projected=projectManualProspect({id:randomUUID(),revision:1,created_at:new Date(),manual_state:'new',duplicate_count:0,payload:{kind:'discovery-v1',row:{...fixture.row,officePhoneEvidence:'absent'}},origins:fixture.origins},phone);
 expect(projected).toMatchObject({observedPhone:null,phoneEvidence:{state:'conflicting',sources:scan.sources.map(source=>expect.objectContaining({literal:source.literal,normalizedValue:source.normalizedValue}))}});
});
it('STANDARDS S1 refuses malformed doubled-plus prefix without a normalized suffix winner',()=>{
 const text='Phone: ++12145550123';expect(scanManualLiteralPhones(input([text]))).toMatchObject({unresolved:true,sources:[]});expect(projectManualPhone(snapshot([text])).state).toBe('conflicting');
});
it('combines repeated equal numbers but preserves distinct numbers across whole input',()=>{
 expect(projectManualPhone(snapshot(['Phone 2145550123','Tel +1 214 555 0123']))).toMatchObject({state:'observed',value:'+12145550123',sources:[{},{}]});
 expect(projectManualPhone(snapshot(['Phone 2145550123 and (214) 555-0124']))).toMatchObject({state:'conflicting',reason:'multiple_retained_numbers'});
});
it('original validation is independent of malformed model facts and composes valid facts',()=>{
 const s=snapshot();s.facts={bad:'model'};expect(projectManualPhone(s)).toMatchObject({state:'observed',sources:[{method:'retained_original_literal'}]});
 const obs=(s.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!;
 s.facts=[{kind:'business_phone',value:'(214) 555-0123',observationId:obs.id,blockId:obs.blocks[0]!.id}];
 expect(projectManualPhone(s)).toMatchObject({state:'observed',sources:[{runId:s.id},{method:'retained_original_literal'}]});
});
it.each(['truncated','hash','future','first_party','authority','host','duplicate_blocks','duplicate_observations','malformed'] as const)('denies unusable original: %s',mode=>{
 const i=input(),sources=i.observations as ReturnType<typeof manualPhoneFixture>['observations'],s=sources[0]!;
 if(mode==='truncated')s.truncated=true;if(mode==='hash')s.relevantTextHash='b'.repeat(64);if(mode==='future')s.retrievedAt=new Date(Date.now()+100000).toISOString();
 if(mode==='first_party')s.firstParty=false;if(mode==='authority')i.authorities={};if(mode==='host')i.website='https://other.example.test/';
 if(mode==='duplicate_blocks')s.blocks.push(s.blocks[0]!);if(mode==='duplicate_observations')sources.push(s);if(mode==='malformed')i.observations={};
 expect(scanManualLiteralPhones(i)).toMatchObject({sources:[],coverage:{state:'unavailable'},reason:'original_not_usable'});
});
it('never selects a prefix on observation/byte/match bounds',()=>{
 const many=input(Array.from({length:17},()=> 'Phone 2145550123'));expect(scanManualLiteralPhones(many)).toMatchObject({sources:[],coverage:{state:'bounded'}});
 const i=input(),s=(i.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!;i.observations=Array.from({length:9},()=>({...s,id:randomUUID()}));
 expect(scanManualLiteralPhones(i).coverage.state).toBe('bounded');
 s.blocks=Array.from({length:100},(_,index)=>({id:String(index),text:'a'.repeat(1500)}));s.relevantTextHash=createHash('sha256').update(JSON.stringify(s.blocks)).digest('hex');i.observations=[s];
 expect(scanManualLiteralPhones(i).coverage.state).toBe('bounded');
});
it('retains escaped source text as text and never parses HTML or candidate prose',()=>{
 const s=snapshot(['<img src=x onerror=alert(1)> Phone: 2145550123']);expect(projectManualPhone(s)).toMatchObject({state:'observed'});
 s.observations=[];s.payload={...manualOrdinaryFixture(775),evidence:'Phone 2145550123'};expect(projectManualPhone(s).state).toBe('not_extracted');
});
it('requires exact source/origin/evidence grants, never host alone',()=>{
 const s=snapshot(),source=(s.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!;
 s.payload={...manualOrdinaryFixture(775),sourceUrl:'https://source.example.test/another',website:'https://source.example.test/'};
 expect(originalAuthorities(s).authorities).toEqual({});
 s.evidence_authorities=[{id:randomUUID(),url:source.url,contentHash:source.contentHash,retrievedAt:source.retrievedAt}];
 expect(originalAuthorities(s).authorities[source.id]?.kind).toBe('retained_evidence');
 s.evidence_authorities[0]!.contentHash='b'.repeat(64);expect(originalAuthorities(s).authorities).toEqual({});
 const d=manualDiscoveryFixture();d.row.source.sourceUrl=source.url;d.row.observations=[d.row.source];d.origins[0]!.source={...d.row.source};
 s.payload={kind:'discovery-v1',row:d.row};s.origins=d.origins;expect(originalAuthorities(s).authorities[source.id]?.kind).toBe('discovery_origin');
 d.origins[0]!.source.recordId='changed';expect(originalAuthorities(s).authorities).toEqual({});
});
it('existing retained interpretation requires surviving exact ancestor and revision, not new recovery',()=>{
 const s=snapshot();expect(originalLineage(s)).toEqual({kind:'provider_original'});
 s.retained_identity_decision_id=randomUUID();expect(projectManualPhone(s)).toMatchObject({state:'not_extracted',reason:'retained_ancestry_unavailable'});
 Object.assign(s,{original_run_id:randomUUID(),original_revision:1,result_revision:1,ancestor_revision:1,decision_candidate_id:s.candidate_id,original_candidate_id:s.candidate_id,original_observations:structuredClone(s.observations)});
 const anchor=(s.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!;Object.assign(s,{decision_observation_id:anchor.id,decision_block_id:anchor.blocks[0]!.id,decision_content_hash:anchor.contentHash,decision_text_hash:anchor.relevantTextHash});
 expect(projectManualPhone(s)).toMatchObject({state:'observed',sources:[{lineage:{kind:'retained_interpretation',decisionId:s.retained_identity_decision_id}}]});
 s.original_observations=[];expect(projectManualPhone(s).state).toBe('not_extracted');
 s.dependency_changed=true;expect(projectManualPhone(s)).toMatchObject({state:'not_extracted',coverage:{state:'changed'}});
});
