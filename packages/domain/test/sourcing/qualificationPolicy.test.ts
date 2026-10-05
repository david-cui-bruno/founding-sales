import {expect,it} from 'vitest';
import {qualifyCandidate,rankQualifiedLeads} from '../../sourcing/qualificationPolicy.ts';
import type {QualificationFact,SourceObservation} from '@fss/contracts';
const now='2026-10-05T12:00:00.000Z';
const identity={status:'resolved' as const,name:'Example PM',website:'https://example.test/',locality:'Dallas',region:'TX'};
function fixture(need:string,kind:QualificationFact['kind']='help_request'){
 const source:SourceObservation={id:'11111111-1111-4111-8111-111111111111',url:'https://example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:'2026-10-01T00:00:00.000Z',publishedAtBlockId:'date',firstParty:true,truncated:false,
 blocks:[{id:'identity',text:'Example PM is a residential property management company in Dallas, Texas.'},{id:'phone',text:'Contact Example PM at (214) 555-0100.'},{id:'need',text:need},{id:'date',text:'Published 2026-10-01'}]};
 const fact=(kind:QualificationFact['kind'],blockId:string):QualificationFact=>({kind,observationId:source.id,blockId,value:source.blocks.find(b=>b.id===blockId)!.text});
 return {identity,now,observations:[source],facts:[fact('firm_identity','identity'),fact('residential_management','identity'),fact('service_area','identity'),fact('business_phone','phone'),fact(kind,'need')]};
}
it('accepts explicit firm-authored maintenance help and operational workload',()=>{
 expect(qualifyCandidate(fixture('We need help with maintenance coordination.'))).toMatchObject({decision:'eligible',rank:'help_request'});
 expect(qualifyCandidate(fixture('Our team is overwhelmed by maintenance calls and vendor follow-up.','operational_burden'))).toMatchObject({decision:'eligible',rank:'operational_burden'});
});
it.each([
 ['We offer maintenance coordination services to property managers.','help_request'],
 ['Residents: call us for emergency maintenance assistance.','help_request'],
 ['Our property managers are responsible for coordinating maintenance.','operational_burden'],
 ['We provide 24/7 maintenance support.','operational_burden'],
 ['Responsibilities: schedule vendors and take tenant calls.','operational_burden'],
 ['We are hiring a maintenance technician to repair HVAC.','coordination_job'],
 ['We are hiring a maintenance coordinator.','coordination_job'],
 ['Our portfolio has grown by 100 homes.','growth'],
 ['We do not need help with maintenance coordination.','help_request'],
 ['A customer says: we need help with maintenance.','help_request'],
 ['We help property managers who are overwhelmed by maintenance calls.','operational_burden'],
 ['If our team is overwhelmed by maintenance calls, we will hire additional staff.','operational_burden'],
 ['We were overwhelmed by maintenance calls in 2020; today everything runs smoothly.','operational_burden'],
 ['We would need help with maintenance coordination if we expanded.','help_request'],
 ['Our team is overwhelmed by maintenance calls was how we described last year; the issue is resolved.','operational_burden'],
 ['Our team is not overwhelmed by maintenance calls.','operational_burden'],
] as const)('keeps ambiguous or non-need text in review: %s',(text,kind)=>{
 expect(qualifyCandidate(fixture(text,kind)).decision).toBe('review');
});
it('requires supported identity, region, residential fit, and a manager-associated phone',()=>{
 const input=fixture('We need help with maintenance coordination.');
 for(const kind of ['firm_identity','residential_management','service_area','business_phone'])expect(qualifyCandidate({...input,facts:input.facts.filter(f=>f.kind!==kind)}).decision).toBe('review');
 expect(qualifyCandidate({...input,identity:{...identity,status:'ambiguous'}}).decision).toBe('review');
 expect(qualifyCandidate({...input,identity:{...identity,region:'CA',locality:'Los Angeles'}}).decision).toBe('review');
 const source=input.observations[0]!;source.blocks.find(b=>b.id==='phone')!.text='Website design: call SiteVendor at (214) 555-0100.';input.facts.find(f=>f.kind==='business_phone')!.value=source.blocks.find(b=>b.id==='phone')!.text;
 expect(qualifyCandidate(input).decision).toBe('review');
});
it('uses observation and publication time independently at exact boundaries',()=>{
 const input=fixture('We need help with maintenance coordination.'),source=input.observations[0]!;
 source.retrievedAt=new Date(Date.parse(now)-7*86400000).toISOString();expect(qualifyCandidate(input).decision).toBe('eligible');
 source.retrievedAt=new Date(Date.parse(now)-7*86400000-1).toISOString();expect(qualifyCandidate(input).unknowns).toContain('evidence_needs_refresh');
 source.retrievedAt=now;source.publishedAt=new Date(Date.parse(now)-30*86400000).toISOString();source.blocks.find(b=>b.id==='date')!.text=`Published ${source.publishedAt.slice(0,10)}`;expect(qualifyCandidate(input).decision).toBe('eligible');
 source.publishedAt=new Date(Date.parse(now)-30*86400000-1).toISOString();source.blocks.find(b=>b.id==='date')!.text=`Published ${source.publishedAt.slice(0,10)}`;expect(qualifyCandidate(input).decision).toBe('review');
 source.publishedAt=null;source.publishedAtBlockId=null;expect(qualifyCandidate(input)).toMatchObject({decision:'review',unknowns:expect.arrayContaining(['help_date_unknown'])});
 source.publishedAt='2099-01-01T00:00:00Z';source.publishedAtBlockId='date';expect(qualifyCandidate(input).decision).toBe('review');
});
it('will not qualify third-party, truncated or unsupported evidence',()=>{
 for(const override of [{firstParty:false},{truncated:true}]){const input=fixture('We need help with maintenance coordination.');Object.assign(input.observations[0]!,override);expect(qualifyCandidate(input).decision).toBe('review');}
 const input=fixture('We need help with maintenance coordination.');input.facts[4]!.value='invented';expect(qualifyCandidate(input).decision).toBe('review');
});
it('ranks categorical evidence with stable ties, without a probability score',()=>{
 const a={id:'a',firmName:'Alpha',rank:'help_request' as const,corroboratingSources:1,observedAt:now,namedContact:false};
 const b={...a,id:'b',firmName:'Beta',rank:'operational_burden' as const,corroboratingSources:2};
 expect(rankQualifiedLeads(a,b)).toBeLessThan(0);expect(rankQualifiedLeads(a,{...a,id:'b'})).toBeLessThan(0);
});
it('rejects a different host despite a firstParty claim, and an unsupported publication date',()=>{
 const other=fixture('We need help with maintenance coordination.');other.observations[0]!.url='https://vendor.test/';expect(qualifyCandidate(other).decision).toBe('review');
 const mismatched=fixture('We need help with maintenance coordination.');mismatched.observations[0]!.publishedAt='2026-10-04T00:00:00Z';expect(qualifyCandidate(mismatched).decision).toBe('review');
});
it('retains existing support without disqualifying an explicit gap, and flags contradictory need',()=>{
 const input=fixture('Our team is overwhelmed by maintenance calls.','operational_burden');
 const source=input.observations[0]!;source.blocks.push({id:'support',text:'We have a maintenance coordinator.'});input.facts.push({kind:'existing_support',observationId:source.id,blockId:'support',value:'We have a maintenance coordinator.'});
 expect(qualifyCandidate(input).decision).toBe('eligible');
 source.blocks.push({id:'contradiction',text:'We do not need maintenance help.'});input.facts.push({kind:'help_request',observationId:source.id,blockId:'contradiction',value:'We do not need maintenance help.'});
 expect(qualifyCandidate(input).unknowns).toContain('need_evidence_conflicts');
});
it('keeps growth in review at the 90-day freshness boundary and jobs with unknown dates undated',()=>{
 const input=fixture('Our portfolio has grown by 100 homes.','growth'),source=input.observations[0]!;
 for(const age of [90*86400000,90*86400000+1]){
  source.publishedAt=new Date(Date.parse(now)-age).toISOString();source.blocks.find(b=>b.id==='date')!.text=`Published ${source.publishedAt.slice(0,10)}`;
  const verdict=qualifyCandidate(input);expect(verdict.decision).toBe('review');expect(verdict.unknowns.includes('event_needs_revalidation')).toBe(age>90*86400000);
 }
 const job=fixture('We are hiring a maintenance coordinator.','coordination_job');job.observations[0]!.publishedAt=null;job.observations[0]!.publishedAtBlockId=null;
 expect(qualifyCandidate(job)).toMatchObject({decision:'review',rank:'investigation',unknowns:expect.arrayContaining(['job_date_unknown'])});
});

it('does not promote a maintenance-service breadcrumb as a coordination vacancy',()=>{
 expect(qualifyCandidate(fixture('You are here: Home / Full-Service Property Management / Maintenance Coordination','coordination_job')).rank).toBe('fit_only');
});
