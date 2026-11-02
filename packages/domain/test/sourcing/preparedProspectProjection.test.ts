import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {preparedProspectBriefSchema,type CandidateInput,type PreparedProspectBrief,type QualificationFact,type SourceObservation} from '@fss/contracts';
import {projectPreparedProspect} from '../../sourcing/preparedProspectProjection.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import {QUALIFICATION_MODEL_NAME} from '../../sourcing/qualificationModel.ts';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',run='10000000-0000-4000-8000-000000000003';
it('binds a derived research gap to the earlier lifetime of an undisplayed contrary source',()=>{
 const now=Date.parse('2026-10-30T20:00:00Z'),website='https://cedar.example.test/',aux=website+'scope';
 const candidate:CandidateInput={firmName:'Home | Cedar',website,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Retained discovery context',sourceUrl:website,observedOn:'2026-10-30',preparedBy:'Fictional retained acceptance'};
 const page=(sourceId:string,url:string,text:string):SourceObservation=>{const blocks=[{id:'whole',text}];return {id:sourceId,url,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(now-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};};
 const positive=page(id,website,'Cedar Property Management manages residential homes for owners across Boston, Massachusetts.'),negative=page(other,aux,'We do not manage residential homes. '+ 'Retained scope explanation. '.repeat(90));
 expect(negative.blocks[0]!.text.length).toBeGreaterThan(2000);expect(negative.blocks[0]!.text.length).toBeLessThanOrEqual(4000);
 const row:ManualProspectRow={id,revision:1,payload:candidate,origins:[],created_at:new Date(now-2000),manual_state:'new',duplicate_count:0};
 const snapshot:ManualPhoneSnapshot={id:run,candidate_id:id,candidate_revision:1,payload:candidate,origins:[],observations:[positive,negative],facts:[],permitted_urls:[website,aux],evidence_authorities:[{id:other,url:aux,contentHash:negative.contentHash,retrievedAt:negative.retrievedAt}]};
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
/** `judgment`: the run's model and its stored selections; absent, a run without the business judgment. */
function callableBrief(texts:string[],firmName='Peak Property Management',peakSite=peakWebsite,judgment?:{model:string;facts:(page:SourceObservation)=>QualificationFact[]},expirations:Map<string,number>=new Map()){
 const candidate:CandidateInput={firmName,website:peakSite,locality:'Richmond',region:'VA',signal:'fit_only',evidence:'Retained discovery context',sourceUrl:peakSite,observedOn:'2026-10-31',preparedBy:'Fictional retained acceptance'};
 const blocks=texts.map((text,index)=>({id:`b${index}`,text}));
 const page:SourceObservation={id,url:peakSite,blocks,contentHash:'a'.repeat(64),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date(callableNow-1000).toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false};
 const row:ManualProspectRow={id,revision:1,payload:candidate,origins:[],created_at:new Date(callableNow-2000),manual_state:'new',duplicate_count:0};
 const snapshot:ManualPhoneSnapshot={id:run,candidate_id:id,candidate_revision:1,payload:candidate,origins:[],observations:[page],facts:judgment?.facts(page)??[],permitted_urls:[peakSite],...judgment?{model_name:judgment.model}:{}};
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

// Business judgment (David, 1 November 2026): a Gemini run's residential_management selections are the business context;
// every other run keeps the passage rules until it is re-qualified.
const selects=(text:string)=>(page:SourceObservation):QualificationFact[]=>page.blocks.filter(b=>b.text===text).map(b=>({kind:'residential_management',value:b.text,observationId:page.id,blockId:b.id}));
const judged=(facts:(page:SourceObservation)=>QualificationFact[])=>({model:QUALIFICATION_MODEL_NAME,facts});
it('keeps the rules-based callable for a run without the business judgment (no regression before re-qualification)',()=>{
 for(const judgment of [undefined,{model:'claude-haiku-4-5',facts:()=>[]}])
  expect(callableOf(callableBrief([peakBusiness,peakPhone,peakPerson],undefined,undefined,judgment))).toEqual({state:'callable',missing:[],phone:'(804) 555-0142',person:peakPerson,residential:true});
});
it('takes business context and residential fit from the judgment run\'s selection, and none without one',()=>{
 const heading='Full Property Management';
 const selected=callableBrief([heading,peakPhone],undefined,undefined,judged(selects(heading)));
 expect(callableOf(selected)).toMatchObject({state:'callable',missing:[],residential:true});
 expect(selected.passages.filter(p=>p.kind==='business').map(p=>p.quote)).toEqual([heading]);
 // The rules would call this business context; the judgment run selected nothing, so it is not.
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,judged(()=>[]))))
  .toMatchObject({state:'not_callable',missing:expect.arrayContaining(['no_business_context']),residential:false});
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,judged(page=>[{kind:'firm_identity',value:peakBusiness,observationId:page.id,blockId:'b0'},{kind:'service_area',value:peakBusiness,observationId:page.id,blockId:'b0'}])))?.missing).toContain('no_business_context');
});
it('drops a selection that does not resolve to an admitted page block with its text: foreign page, unknown block, other text or expired page',()=>{
 for(const facts of [()=>[{kind:'residential_management' as const,value:peakBusiness,observationId:other,blockId:'b0'}],(page:SourceObservation)=>[{kind:'residential_management' as const,value:peakBusiness,observationId:page.id,blockId:'missing'}],(page:SourceObservation)=>[{kind:'residential_management' as const,value:peakPhone,observationId:page.id,blockId:'b0'}]])
  expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,judged(facts)))?.missing).toContain('no_business_context');
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,judged(selects(peakBusiness)),new Map([[peakWebsite,callableNow-1]]))))
  .toMatchObject({state:'not_callable',missing:expect.arrayContaining(['no_business_context'])});
 // One bad selection drops itself; the valid one still counts.
 expect(callableOf(callableBrief([peakBusiness,peakPhone],undefined,undefined,judged(page=>[{kind:'residential_management',value:peakBusiness,observationId:other,blockId:'b0'},...selects(peakBusiness)(page)]))))
  .toMatchObject({state:'callable'});
});
it('keeps contrary and attributed wording blocking a selected block',()=>{
 const contrary='Peak Property Management does not manage residential homes or apartments in Richmond.';
 expect(callableOf(callableBrief([contrary,peakPhone],undefined,undefined,judged(selects(contrary)))))
  .toMatchObject({state:'not_callable',missing:expect.arrayContaining(['contrary_context'])});
 const testimonial='Testimonial: Peak Property Management manages our rental homes.';
 expect(callableOf(callableBrief([testimonial,peakPhone],undefined,undefined,judged(selects(testimonial))))?.missing).toContain('no_business_context');
});
