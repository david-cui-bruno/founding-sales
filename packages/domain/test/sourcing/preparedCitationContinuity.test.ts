import {expect,it} from 'vitest';
import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import {qualificationExtractionCitationRoles,qualificationCitationRoles} from '../../sourcing/qualificationCitationRoles.ts';
import {nativeFirmCitations} from '../../sourcing/nativeFirmEligibility.ts';
import {readPhoneOfficeProof} from '../../dial/phoneOfficeProof.ts';
import {officeHash} from '../../research/officeAssessmentTarget.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {qualifyEmailCandidate} from '../../outreach/selection.ts';

function fixture(locality='Boston',region:CandidateInput['region']='MA',state='Massachusetts',weak=`${locality}, ${state} Welcome Home`){
 const candidate={firmName:'Harbor Example Management',website:'https://harbor.example.test/',locality,region};
 const now='2026-10-30T05:00:00.000Z';
 const source:SourceObservation={id:'11111111-1111-4111-8111-111111111111',url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[
  {id:'name',text:candidate.firmName},{id:'label',text:weak},
  {id:'description',text:`${candidate.firmName} manages residential homes in ${locality}, ${state}.`},
  {id:'email',text:`Contact ${candidate.firmName} office in ${locality}, ${region} at info@harbor.example.test.`},
 ]};
 const fact=(kind:QualificationFact['kind'],id:string):QualificationFact=>({kind,observationId:source.id,blockId:id,value:source.blocks.find(b=>b.id===id)!.text});
 const facts=[fact('firm_identity','name'),fact('service_area','label'),fact('residential_management','description'),fact('business_email','email')];
 return {candidate,now,source,facts,fact};
}
const examples:[string,CandidateInput['region'],string,string][]=[
 ['Boston','MA','Massachusetts','Boston, Massachusetts Welcome Home'],
 ['Providence','RI','Rhode Island','Providence, Rhode Island Welcome Home'],
 ['Dallas','TX','Texas','100 Main Street, Dallas, TX 75001'],
 ['Los Angeles','CA','California','Los Angeles, CA Welcome Home'],
];
it.each(examples)('preserves weak selected geography while adding its unique current citable paragraph for %s', (city,region,state,weak)=>{
 const f=fixture(city,region,state,weak),original=JSON.stringify(f);
 const result=qualificationExtractionCitationRoles(f.candidate,f.facts,[f.source]);
 expect(result.ok).toBe(true);if(!result.ok)return;
 expect(result.facts).toEqual([...f.facts,f.fact('service_area','description')]);
 expect(JSON.stringify(f)).toBe(original);
 const native=nativeFirmCitations({candidate:f.candidate,facts:result.facts,observations:[f.source],now:f.now});
 expect(native).toMatchObject({citations:expect.arrayContaining([expect.objectContaining({kind:'service_area',blockId:'description'})])});
 if(region!=='CA')expect(qualifyEmailCandidate({identity:{status:'resolved',name:f.candidate.firmName,website:f.candidate.website,locality:city,region},facts:result.facts,observations:[f.source],now:f.now})).toMatchObject({decision:'eligible',unknowns:[]});
});
it('does not choose between two descriptive service-area originals',()=>{
 const f=fixture();f.source.blocks.push({id:'second',text:f.source.blocks[2]!.text});
 const result=qualificationExtractionCitationRoles(f.candidate,f.facts,[f.source]);expect(result).toEqual({ok:true,facts:f.facts});
 expect(nativeFirmCitations({candidate:f.candidate,facts:f.facts,observations:[f.source],now:f.now})).toMatchObject({status:'unavailable',reason:'service_area_unresolved'});
});
it('leaves an already citable selected service-area fact unchanged',()=>{
 const f=fixture();f.facts[1]=f.fact('service_area','description');expect(qualificationExtractionCitationRoles(f.candidate,f.facts,[f.source])).toEqual({ok:true,facts:f.facts});
});
it('retains the selection ceiling instead of dropping facts to make room',()=>{
 const f=fixture();while(f.facts.length<30)f.facts.push(f.fact('business_email','email'));
 expect(qualificationExtractionCitationRoles(f.candidate,f.facts,[f.source])).toMatchObject({ok:false,reason:'invalid_evidence',diagnostic:{code:'supplement_over_bound'}});
});

it('preserves the actual retained strict phone reader at thirty facts while refusing new producer overflow',async()=>{
 const f=fixture();f.source.blocks.push({id:'phone',text:`${f.candidate.firmName} office: Boston, MA. Contact ${f.candidate.firmName} (617) 555-0190.`});
 f.facts[3]=f.fact('business_phone','phone');while(f.facts.length<30)f.facts.push(f.fact('business_phone','phone'));
 f.source.relevantTextHash=officeHash(JSON.stringify(f.source.blocks));
 expect(qualificationCitationRoles(f.candidate,f.facts,[f.source])).toEqual({ok:true,facts:f.facts});
 expect(qualificationExtractionCitationRoles(f.candidate,f.facts,[f.source])).toMatchObject({ok:false,diagnostic:{code:'supplement_over_bound'}});
 const id='22222222-2222-4222-8222-222222222222';
 const ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:async<Row,>(sql:string)=>{
  let rows:unknown[]=[];
  if(sql.startsWith('SELECT name,website'))rows=[{name:f.candidate.firmName,website:f.candidate.website,locality:f.candidate.locality,region_code:f.candidate.region}];
  else if(sql.includes('SELECT known_personal_cell_at'))rows=[{known_personal_cell_at:null}];
  else if(sql.includes('SELECT q.id,c.payload'))rows=[{id,payload:f.candidate,observations:[f.source],facts:f.facts,policy_version:'qualification-v5',prompt_version:'qualification-context-v7'}];
  else if(!sql.includes('sourcing_candidates')&&!sql.includes('SELECT q.observations')&&!sql.includes('firm_office_assessments')&&!sql.includes('SELECT s.observation'))throw Error('Unexpected query');
  return {rows:rows as Row[],rowCount:rows.length};
 }});
 expect(await readPhoneOfficeProof(ctx,{firmId:id,routeId:id,routeVersion:1,e164:'+16175550190',at:f.now,expected:{kind:'admission',id}})).toEqual({kind:'admission',id,expiresAt:'2026-11-06T05:00:00.000Z'});
});
