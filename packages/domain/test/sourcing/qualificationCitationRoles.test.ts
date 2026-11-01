import {expect,it} from 'vitest';
import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {qualificationCitationRoles} from '../../sourcing/qualificationCitationRoles.ts';
const candidate={firmName:'Harbor Example Management',locality:'Boston',region:'MA' as const,website:'https://harbor.example.test/'};
const source:SourceObservation={id:'11111111-1111-4111-8111-111111111111',url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-18T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:candidate.firmName},{id:'b2',text:'Harbor Example Management manages residential homes in Boston, Massachusetts.'},{id:'b3',text:'We provide excellent services.'},{id:'b4',text:'Another Actual Company LLC'},{id:'b5',text:'100 Main Street, Newton, MA 02459'},{id:'b6',text:'Call us at 617-555-0190'}]};
const fact=(id:string,kind:QualificationFact['kind']):QualificationFact=>({kind,observationId:source.id,blockId:id,value:source.blocks.find(b=>b.id===id)!.text});
it('supplements only unique original literal identity and named descriptive geography, without mutating evidence',()=>{
 const before=JSON.stringify(source),selected=[fact('b2','residential_management'),fact('b5','service_area'),fact('b6','business_phone')];
 expect(qualificationCitationRoles(candidate,selected,[source])).toEqual({ok:true,facts:[...selected,fact('b1','firm_identity'),fact('b2','service_area')]});
 expect(selected).toHaveLength(3);expect(JSON.stringify(source)).toBe(before);
});
it.each(['b3','b4'])('refuses nameless or genuinely contradictory selected identity %s rather than dropping it',id=>{
 const facts=[fact('b1','firm_identity'),fact(id,'firm_identity')],before=JSON.stringify(facts);
 expect(qualificationCitationRoles(candidate,facts,[source])).toMatchObject({ok:false,reason:'invalid_evidence'});expect(JSON.stringify(facts)).toBe(before);
});
it.each([{truncated:true},{firstParty:false},{url:'https://other.example.test/'}])('refuses selected references from unusable source %j',edit=>{
 expect(qualificationCitationRoles(candidate,[fact('b1','firm_identity')],[{...source,...edit}])).toMatchObject({ok:false,reason:'invalid_evidence'});
 expect(qualificationCitationRoles(candidate,[],[{...source,...edit}])).toEqual({ok:true,facts:[]});
});
it('never matches fuzzy names, whole-state geography, missing-state city, or foreign office as target',()=>{
 for(const text of ['Harbor Examples Management','Harbor Example Management manages residential homes in Massachusetts.','Harbor Example Management manages residential homes in Boston.','Harbor Example Management manages residential homes in Newton, MA.','Harbor Example Management serves Boston clients from its Newton, MA residential property management office.']){
  const observation={...source,blocks:[{id:'b1',text}]};expect(qualificationCitationRoles(candidate,[],[observation])).toEqual({ok:true,facts:[]});
 }
 expect(qualificationCitationRoles(candidate,[fact('b5','service_area')],[{...source,blocks:[source.blocks[4]!]}])).toEqual({ok:true,facts:[fact('b5','service_area')]});
});
it('does not choose among multiple candidate citations or synthesize a joined service statement',()=>{
 expect(qualificationCitationRoles(candidate,[],[{...source,blocks:[{id:'a',text:candidate.firmName},{id:'b',text:candidate.firmName}]}])).toEqual({ok:true,facts:[]});
 expect(qualificationCitationRoles(candidate,[],[{...source,blocks:[{id:'a',text:'Harbor Example Management manages residential homes in Boston.'},{id:'b',text:'Massachusetts'}]}])).toEqual({ok:true,facts:[]});
});
it('refuses invalid literal references and supplementation overflow without dropping existing facts',()=>{
 expect(qualificationCitationRoles(candidate,[{...fact('b1','firm_identity'),value:'invented'}],[source])).toMatchObject({ok:false,reason:'invalid_evidence'});
 expect(qualificationCitationRoles(candidate,Array.from({length:30},()=>fact('b2','residential_management')),[source])).toMatchObject({ok:false,reason:'invalid_evidence'});
});
it('distinguishes literal identity, forbidden attribution and overflow without retaining text',()=>{
 const nameless=qualificationCitationRoles(candidate,[fact('b3','firm_identity')],[source]);
 expect(nameless).toMatchObject({ok:false,reason:'invalid_evidence',diagnostic:{stage:'citation_roles',code:'identity_not_literal',selectionIndex:0,selectionCount:1,observationId:source.id,blockId:'b3'}});
 const forbidden={...source,blocks:[{id:'b1',text:`Website by ${candidate.firmName}`} ]};
 expect(qualificationCitationRoles(candidate,[{kind:'firm_identity',value:forbidden.blocks[0]!.text,observationId:source.id,blockId:'b1'}],[forbidden])).toMatchObject({ok:false,diagnostic:{code:'identity_forbidden'}});
 expect(qualificationCitationRoles(candidate,Array.from({length:30},()=>fact('b2','residential_management')),[source])).toMatchObject({ok:false,diagnostic:{code:'supplement_over_bound',selectionCount:30}});
 const overflow=qualificationCitationRoles(candidate,Array.from({length:31},()=>fact('b2','residential_management')),[source]);
 expect(overflow).toMatchObject({ok:false,diagnostic:{code:'selections_over_bound'}});if(!overflow.ok)expect(overflow.diagnostic).not.toHaveProperty('selectionCount');
 expect(JSON.stringify(nameless)).not.toContain(source.blocks[2]!.text);
});
it('distinguishes unusable source, missing block, mismatched citation and oversized block',()=>{
 expect(qualificationCitationRoles(candidate,[fact('b1','firm_identity')],[{...source,truncated:true}])).toMatchObject({ok:false,diagnostic:{code:'source_unusable'}});
 const missing=qualificationCitationRoles(candidate,[{...fact('b1','firm_identity'),blockId:'private missing block'}],[source]);
 expect(missing).toMatchObject({ok:false,diagnostic:{code:'block_missing',observationId:source.id}});if(!missing.ok)expect(missing.diagnostic).not.toHaveProperty('blockId');
 expect(qualificationCitationRoles(candidate,[{...fact('b1','firm_identity'),value:'not published'}],[source])).toMatchObject({ok:false,diagnostic:{code:'citation_mismatch'}});
 const long={...source,blocks:[{id:'long',text:'x'.repeat(2001)}]};
 expect(qualificationCitationRoles(candidate,[{kind:'firm_identity',value:long.blocks[0]!.text,observationId:source.id,blockId:'long'}],[long])).toMatchObject({ok:false,diagnostic:{code:'block_over_bound'}});
 expect(qualificationCitationRoles({...candidate,locality:''},[],[source])).toMatchObject({ok:false,diagnostic:{code:'candidate_invalid'}});
});
it('leaves a moved-site residential_management selection out of every citation read, never as authority',()=>{
 const moved={...source,url:'https://harbor-moved.example.test/'};
 expect(qualificationCitationRoles(candidate,[fact('b2','residential_management')],[moved])).toEqual({ok:true,facts:[]});
 expect(qualificationCitationRoles(candidate,[fact('b1','firm_identity')],[moved])).toMatchObject({ok:false,diagnostic:{code:'source_unusable'}});
 for(const edit of [{truncated:true},{firstParty:false}])expect(qualificationCitationRoles(candidate,[fact('b2','residential_management')],[{...moved,...edit}])).toMatchObject({ok:false,diagnostic:{code:'source_unusable'}});
});
