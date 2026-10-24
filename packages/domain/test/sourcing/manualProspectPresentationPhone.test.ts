import {expect,it} from 'vitest';
import {manualProspectPresentation} from '../../sourcing/manualProspectPresentation.ts';
import {projectManualProspect,type ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import {projectManualPhone,type ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture} from './support/manualPhoneFixture.ts';
const id='10000000-0000-4000-8000-000000000001';
const row=(payload:unknown,origins:unknown=null):ManualProspectRow=>({id,revision:1,created_at:new Date('2026-10-24T00:00:00Z'),manual_state:'new',duplicate_count:0,payload,origins});
function snapshot(values=['(214) 555-0123']):ManualPhoneSnapshot{
 const evidence=manualPhoneFixture('https://source.example.test/phone',values);
 return {id,candidate_id:id,candidate_revision:1,...evidence,permitted_urls:[evidence.observations[0]!.url]};
}
it('cleans retained title-like names without asserting new source-title or canonical identity',()=>{
 expect(manualProspectPresentation('Home | Boston Property Management - Contact','https://example.test/')).toMatchObject({label:'Boston Property Management',basis:'retained_name',kind:'apparent_company'});
 for(const name of ['Property Management Certificate','Department of Housing','Top 10 property management companies'])expect(manualProspectPresentation(name,null).kind).toBe('non_company');
 expect(manualProspectPresentation('Unknown fit person or place',null).kind).toBe('unresolved');
 expect(manualProspectPresentation('Business','https://example.gov/').kind).toBe('non_company');
 expect(manualProspectPresentation('Business','https://propertymanagement.com/').kind).toBe('non_company');
 expect(manualProspectPresentation('<img src=x onerror=alert(1)>','javascript:alert(1)')).toMatchObject({label:'<img src=x onerror=alert(1)>',basis:'retained_name',kind:'unresolved'});
});
it('keeps unknown-fit/non-company original names and all notices in projection',()=>{
 const input=manualDiscoveryFixture();input.row.firmName='Property Management Certificate';
 const p=projectManualProspect(row({kind:'discovery-v1',row:input.row},input.origins));
 expect(p).toMatchObject({observedName:input.row.firmName,presentation:{kind:'non_company'},phoneEvidence:{state:'not_extracted',reason:'no_retained_phone_field'}});
 expect(p?.sourceNotices).toHaveLength(2);
});
it('distinguishes explicit retained absence and ambiguity from missing field or a phone evidence enum',()=>{
 const input=manualDiscoveryFixture();
 for(const [declared,state] of [['unknown','not_extracted'],['observed_source','not_extracted'],['absent','absent'],['ambiguous','conflicting']] as const){
  input.row.officePhoneEvidence=declared;
  expect(projectManualProspect(row({kind:'discovery-v1',row:input.row},input.origins))).toMatchObject({observedPhone:null,phoneEvidence:{state}});
 }
 expect(projectManualProspect(row(manualOrdinaryFixture()))?.phoneEvidence?.state).toBe('not_extracted');
});
it('normalizes only grounded structured whole phone facts with exact retained provenance, not office/fit eligibility',()=>{
 const s=snapshot(),p=projectManualPhone(s);
 expect(p).toEqual({state:'observed',value:'+12145550123',sources:[{runId:id,observationId:(s.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!.id,blockId:'phone-0',url:'https://source.example.test/phone',retrievedAt:(s.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!.retrievedAt}]});
 expect(projectManualProspect(row(manualOrdinaryFixture()),p)).toMatchObject({observedPhone:'+12145550123',phoneBasis:'retained_observation',phoneEvidence:p});
});
it('does not select a conflicting number or invent absence from unextracted retained text',()=>{
 expect(projectManualPhone(snapshot(['2145550123','2145550124']))).toMatchObject({state:'conflicting',reason:'multiple_retained_numbers',sources:[{},{}]});
 expect(projectManualPhone(snapshot([]))).toEqual({state:'not_extracted',reason:'retained_text_not_extracted'});
 expect(projectManualPhone(undefined)).toEqual({state:'not_extracted',reason:'no_current_permitted_phone_evidence'});
 const s=snapshot();s.permitted_urls=[];expect(projectManualPhone(s).state).toBe('not_extracted');
});
it('never mines prose, URLs, notices, unrelated blocks or ungrounded assertions for phone numbers',()=>{
 for(const value of ['Call Boston PM at 214-555-0123','https://example.test/2145550123','tel:+12145550123'])expect(projectManualPhone(snapshot([value])).state).toBe('not_extracted');
 const s=snapshot(),facts=s.facts as ReturnType<typeof manualPhoneFixture>['facts'];facts[0]!.blockId='missing';expect(projectManualPhone(s).state).toBe('not_extracted');
 const unsafe=snapshot();(unsafe.observations as ReturnType<typeof manualPhoneFixture>['observations'])[0]!.url='https://user:secret@source.example.test/phone';expect(projectManualPhone(unsafe).state).toBe('not_extracted');
});
it('retains contradictions between an explicit absence and an observed phone rather than picking a winner',()=>{
 const input=manualDiscoveryFixture();input.row.officePhoneEvidence='absent';
 expect(projectManualProspect(row({kind:'discovery-v1',row:input.row},input.origins),projectManualPhone(snapshot()))).toMatchObject({observedPhone:null,phoneEvidence:{state:'conflicting',reason:'retained_source_ambiguous',sources:[{}]}});
});
