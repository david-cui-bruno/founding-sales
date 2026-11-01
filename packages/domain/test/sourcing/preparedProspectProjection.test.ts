import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {preparedProspectBriefSchema,type CandidateInput,type PreparedProspectBrief,type QualificationFact,type SourceObservation} from '@fss/contracts';
import {projectPreparedProspect} from '../../sourcing/preparedProspectProjection.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {residentialFacts} from './support/modelSelections.ts';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',run='10000000-0000-4000-8000-000000000003';
it('binds a derived research gap to the earlier lifetime of an undisplayed contrary source',()=>{
 const now=Date.parse('2026-10-30T20:00:00Z'),website='https://cedar.example.test/',aux=website+'scope';
 const candidate:CandidateInput={firmName:'Home | Cedar',website,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Retained discovery context',sourceUrl:website,observedOn:'2026-10-30',preparedBy:'Fictional retained acceptance'};
 const page=(sourceId:string,url:string,text:string):SourceObservation=>{const blocks=[{id:'whole',text}];return {id:sourceId,url,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(now-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};};
 const positive=page(id,website,'Cedar Property Management manages residential homes for owners across Boston, Massachusetts.'),negative=page(other,aux,'We do not manage residential homes. '+ 'Retained scope explanation. '.repeat(90));
 expect(negative.blocks[0]!.text.length).toBeGreaterThan(2000);expect(negative.blocks[0]!.text.length).toBeLessThanOrEqual(4000);
 const row:ManualProspectRow={id,revision:1,payload:candidate,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0};
 const snapshot:ManualPhoneSnapshot={id:run,candidate_id:id,candidate_revision:1,payload:candidate,origins:[],observations:[positive,negative],facts:residentialFacts([positive,negative]),permitted_urls:[website,aux],evidence_authorities:[{id:other,url:aux,contentHash:negative.contentHash,retrievedAt:negative.retrievedAt}]};
 const early=now+10000,late=now+60000;
 const brief=projectPreparedProspect(row,snapshot,{id:run,candidate_revision:1},now,new Map([[website,late],[aux,early]]));
 expect(brief).toMatchObject({state:'needs_research',validUntil:new Date(early).toISOString()});
 expect(brief?.unknowns.join(' ')).toContain('Contrary wording exceeds');expect(brief?.passages.map(p=>p.quote)).toEqual([positive.blocks[0]!.text]);
});

// ADR0034 callable research readiness. Fictional October31-shaped own-site passages.
const callableNow=Date.parse('2026-10-31T20:00:00Z'),peakWebsite='https://peak.example.test/';
const peakBusiness='Peak Property Management manages rental properties for landlords and investors throughout the Richmond area.';
const peakPhone='Questions about your rental? Call us at (804) 555-0142.';
const peakPerson='Jordan Reyes, Owner';
function callableBrief(texts:string[],firmName='Peak Property Management',peakSite=peakWebsite,selections:(page:SourceObservation)=>QualificationFact[]=page=>residentialFacts([page]),expirations:Map<string,number>=new Map()){
 const candidate:CandidateInput={firmName,website:peakSite,locality:'Richmond',region:'VA',signal:'fit_only',evidence:'Retained discovery context',sourceUrl:peakSite,observedOn:'2026-10-31',preparedBy:'Fictional retained acceptance'};
 const blocks=texts.map((text,index)=>({id:`b${index}`,text}));
 const page:SourceObservation={id,url:peakSite,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(callableNow-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};
 const row:ManualProspectRow={id,revision:1,payload:candidate,origins:[],created_at:new Date(callableNow-2000),manual_state:'new',duplicate_count:0};
 const snapshot:ManualPhoneSnapshot={id:run,candidate_id:id,candidate_revision:1,payload:candidate,origins:[],observations:[page],facts:selections(page),permitted_urls:[peakSite]};
 return preparedProspectBriefSchema.parse(projectPreparedProspect(row,snapshot,{id:run,candidate_revision:1},callableNow,expirations));
}
const callableOf=(brief:PreparedProspectBrief)=>brief.policyVersion==='prepared-prospect-v2'?brief.callable:null;
it('marks an own-site prepared company with business context and a published US phone callable, without contact authority',()=>{
 const brief=callableBrief([peakBusiness,peakPhone,peakPerson]);
 expect(brief).toMatchObject({state:'prepared',contactAuthority:'not_granted'});
 expect(callableOf(brief)).toEqual({state:'callable',missing:[],phone:'(804) 555-0142',person:peakPerson,residential:true});
 expect(brief.passages.filter(p=>p.kind==='contact').map(p=>p.quote)).toEqual([peakPhone]);
 expect(brief.unknowns.join(' ')).toMatch(/not verified routes or contact permission/iu);
});
it.each([
 ['missing phone',[peakBusiness,'Email the office at office@peak.example.test for rental questions.'],'Peak Property Management',['no_published_phone']],
 ['unlabelled or ambiguous phone',[peakBusiness,'Fax: (804) 555-0143 · Phone: (804) 555-0142'],'Peak Property Management',['no_published_phone']],
 ['contrary context',[peakBusiness,peakPhone,'We do not manage residential homes or apartments in Richmond.'],'Peak Property Management',['needs_research','contrary_context']],
 ['list page',[peakBusiness,peakPhone],'Top 10 Property Management Companies in Richmond',['list_page']],
 ['needs research',[peakPhone],'Peak Property Management',['needs_research','no_business_context']],
] as const)('refuses callable for %s with closed reasons',(_label,texts,name,missing)=>{
 const callable=callableOf(callableBrief([...texts],name));
 expect(callable).toMatchObject({state:'not_callable',missing:[...missing]});
});
it('shows identical quote text once, keeping the first intact block',()=>{
 const workflow='Our team collects rent online and coordinates maintenance for tenants of the single-family homes in our care.';
 const brief=callableBrief([peakBusiness,workflow,peakPhone,workflow,peakPhone]);
 expect(brief.passages.map(p=>[p.blockId,p.quote])).toEqual([['b0',peakBusiness],['b2',peakPhone],['b1',workflow]]);
 expect(callableOf(brief)).toMatchObject({state:'callable',phone:'(804) 555-0142'});
});
it.each([
 ['(804) 555-0142','(804) 555-0142'],
 ['804.555.0142 office@peak.example.test','804.555.0142'],
 ['For rental questions or an estimate, please call 804.555.0142, or email us.','804.555.0142'],
])('v2 published-number forms make the company callable: %s',(text,phone)=>{
 expect(callableOf(callableBrief([peakBusiness,text]))).toMatchObject({state:'callable',phone});
});
it('requires a company page: a non-company (.gov) host with a phone is not callable',()=>{
 const brief=callableBrief([peakBusiness,peakPhone],'Peak Property Management','https://housing.example.gov/');
 expect(callableOf(brief)).toMatchObject({state:'not_callable',missing:['not_company_page'],phone:'(804) 555-0142'});
 expect(brief.policyVersion==='prepared-prospect-v2'&&brief.companyHost).toBe('housing.example.gov');
});
it('takes the callable person only from a person passage included in the brief',()=>{
 const long=(name:string)=>`${name}, President, joined the firm many years ago and `+'enjoys hiking, reading and volunteering with neighborhood groups on weekends. '.repeat(3);
 const first=long('Morgan Lane'),second=long('Avery Stone');expect(first.length).toBeGreaterThan(200);
 const brief=callableBrief([peakBusiness,peakPhone,first,second,peakPerson]);
 expect(callableOf(brief)).toMatchObject({state:'callable',person:peakPerson});
 expect(brief.passages.filter(p=>p.kind==='person').map(p=>p.quote)).toContain(peakPerson);
 expect(brief.policyVersion==='prepared-prospect-v2'&&brief.companyHost).toBe('peak.example.test');
});

// Business context is the run's model selection (David, Nov 1), resolved only through admitted pages.
it('takes business context and residential fit from a residential_management selection, and none without one',()=>{
 const label='Full Property Management';
 const selected=callableBrief([label,peakPhone],undefined,undefined,page=>[{kind:'residential_management',value:label,observationId:page.id,blockId:'b0'}]);
 expect(callableOf(selected)).toMatchObject({state:'callable',missing:[],residential:true});
 expect(selected.passages.filter(p=>p.kind==='business').map(p=>p.quote)).toEqual([label]);
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,()=>[]))).toMatchObject({state:'not_callable',missing:['needs_research','no_business_context'],residential:false});
 // firm_identity and service_area selections are not business context.
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,page=>[{kind:'firm_identity',value:'Peak Property Management',observationId:page.id,blockId:'b0'},{kind:'service_area',value:'Richmond',observationId:page.id,blockId:'b0'}]))?.missing).toContain('no_business_context');
});
it('ignores a selection that does not resolve to an admitted page block: foreign observation, unknown block or expired page',()=>{
 for(const selections of [()=>[{kind:'residential_management' as const,value:peakBusiness,observationId:other,blockId:'b0'}],(page:SourceObservation)=>[{kind:'residential_management' as const,value:peakBusiness,observationId:page.id,blockId:'missing'}]])
  expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,selections))?.missing).toContain('no_business_context');
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,undefined,new Map([[peakWebsite,callableNow-1]])))).toMatchObject({state:'not_callable',missing:expect.arrayContaining(['no_business_context'])});
});
it('keeps contrary wording blocking callable even when the model selected the block',()=>{
 const contrary='Peak Property Management does not manage residential homes or apartments in Richmond.';
 const brief=callableBrief([contrary,peakPhone],undefined,undefined,page=>[{kind:'residential_management',value:contrary,observationId:page.id,blockId:'b0'}]);
 expect(callableOf(brief)).toMatchObject({state:'not_callable',missing:expect.arrayContaining(['needs_research','contrary_context'])});
});
