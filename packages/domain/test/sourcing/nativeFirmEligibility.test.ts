import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {nativeFirmCitations,nativeFirmEvidence,type NativeEvidenceInput} from '../../sourcing/nativeFirmEligibility.ts';
import {verifiedFirmEvidence} from '../../sourcing/verifiedFirmPolicy.ts';
function input():Omit<NativeEvidenceInput,'facts'|'observations'>&{facts:QualificationFact[];observations:SourceObservation[]} {
 const now='2026-10-21T12:00:00.000Z',id=randomUUID();
 const candidate:NativeEvidenceInput['candidate']={firmName:'Synthetic Harbor LLC',website:'https://harbor.example.test/',locality:'Dallas',region:'TX'};
 const text='Synthetic Harbor LLC provides residential property management in Dallas, TX.';
 return {candidate,now,observations:[{id,url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text}]}],facts:(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value:text,observationId:id,blockId:'native'}))};
}
it('shares behavior-identical pre-phone core while native proof grants no phone/channel',()=>{
 const i=input();expect(nativeFirmEvidence(i)).toMatchObject({kind:'verified'});expect(verifiedFirmEvidence(i)).toMatchObject({kind:'verified',phone:null});
 expect(nativeFirmCitations(i)).toMatchObject({citations:expect.arrayContaining([expect.objectContaining({kind:'service_area'})]),validUntil:'2026-10-28T12:00:00.000Z'});
});
it.each([{truncated:true},{firstParty:false},{url:'https://other.example.test/'},{retrievedAt:'2026-10-22T12:00:00.000Z'},{retrievedAt:'2026-10-13T12:00:00.000Z'}])('never derives usable native proof from unusable current source %j',edit=>{
 const i=input();Object.assign(i.observations[0]!,edit);expect(nativeFirmCitations(i)).toMatchObject({status:'unavailable'});
});
it('requires full selected block equality even when ordinary evidence schema permits substring grounding',()=>{
 const i=input();i.facts[0]={...i.facts[0]!,value:'Synthetic Harbor LLC'};
 expect(nativeFirmCitations(i)).toEqual({status:'unavailable',reason:'evidence_invalid',channelAuthority:'not_granted'});
});
it.each(['Utility address Dallas, TX.','Other Company office Dallas, TX.','Synthetic Harbor LLC vendor Dallas, TX.'])('does not borrow unrelated service-area citations: %s',text=>{
 const i=input();i.observations[0]!.blocks.push({id:'area',text});i.facts[1]={...i.facts[1]!,value:text,blockId:'area'};
 expect(nativeFirmCitations(i)).toMatchObject({status:'unavailable',reason:'service_area_unresolved'});
});
it('selects the actual supported service-area block rather than the first unsupported geography label',()=>{
 const i=input();i.observations[0]!.blocks.unshift({id:'other',text:'Other Company office Austin, TX.'});i.facts.unshift({kind:'service_area',value:'Other Company office Austin, TX.',observationId:i.observations[0]!.id,blockId:'other'});
 const proof=nativeFirmCitations(i);expect(proof).toMatchObject({citations:expect.arrayContaining([expect.objectContaining({kind:'service_area',blockId:'native'})])});
});
it('leaves statewide calling-wrapper behavior unchanged while native adapter keeps supported target localities',()=>{
 const i=input();i.candidate={...i.candidate,region:'RI',locality:'Newport'};const text='Synthetic Harbor LLC provides residential property management in Newport, RI.';i.observations[0]!.blocks[0]!.text=text;i.facts=i.facts.map(f=>({...f,value:text}));
 expect(verifiedFirmEvidence(i)).toMatchObject({kind:'verified',phone:null});expect(nativeFirmCitations(i)).toMatchObject({status:'unavailable',reason:'geography_unsupported'});
});
it('retains contrary residential and identity refusal, including unselected complete source blocks',()=>{
 for(const text of ['We manage commercial properties exclusively.','We do not manage residences.']){const i=input();i.observations[0]!.blocks.push({id:'contrary',text});expect(nativeFirmCitations(i)).toMatchObject({status:'unavailable',reason:'residential_fit_unresolved'});}
 const i=input();i.observations[0]!.blocks.push({id:'other',text:'Other Company'});i.facts.push({kind:'firm_identity',value:'Other Company',observationId:i.observations[0]!.id,blockId:'other'});expect(nativeFirmCitations(i)).toMatchObject({status:'unavailable'});
});
it('does not convert a role-supplemented human-shaped seed into retained native facts',()=>{
 const i=input();i.facts=i.facts.filter(f=>f.kind!=='firm_identity');i.observations[0]!.blocks.push({id:'name',text:i.candidate.firmName});
 expect(nativeFirmCitations(i)).toMatchObject({status:'unavailable',reason:'identity_unresolved'});
});
