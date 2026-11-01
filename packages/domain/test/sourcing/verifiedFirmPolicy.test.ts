import {it,expect} from 'vitest';
import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import {verifiedFirmEvidence,verifiedWebsiteKey,validVerifiedFirmAttestation,VERIFIED_FIRM_POLICY_VERSION} from '../../sourcing/verifiedFirmPolicy.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import {discoveryQuotaRemaining} from '../../sourcing/discoveryQuota.ts';
const now='2026-10-18T12:00:00.000Z';
const candidate:CandidateInput={firmName:'Harbor Residential LLC',website:'https://harbor.example.test/dallas',sourceUrl:'https://harbor.example.test/dallas',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unverified search',preparedBy:'Tavily Basic search · not verified',observedOn:'2026-10-18'};
function evidence(c:CandidateInput=candidate){
 const observation:SourceObservation={id:'00000000-0000-4000-8000-000000000001',url:c.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'office',text:`${c.firmName} office: ${c.locality}, ${c.region}. We provide residential property management.`},{id:'phone',text:`Contact ${c.firmName} at (214) 555-0190.`}]};
 const facts:QualificationFact[]=[...(['firm_identity','residential_management','service_area'] as const).map(kind=>({kind,value:observation.blocks[0]!.text,observationId:observation.id,blockId:'office'})),{kind:'business_phone',value:observation.blocks[1]!.text,observationId:observation.id,blockId:'phone'}];
 return {candidate:c,facts,observations:[observation],now};
}
it('pins the combined policy revisions without changing the extraction prompt',()=>{
 expect(QUALIFICATION_POLICY_VERSION).toBe('qualification-v5');
 expect(VERIFIED_FIRM_POLICY_VERSION).toBe('verified-firm-v3');
 expect(QUALIFICATION_PROMPT_VERSION).toBe('qualification-context-v7');
});
it('requires a fresh explicit versioned attestation, not a legacy true flag or old reviewed report',()=>{
 const current={policyVersion:QUALIFICATION_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,reportSha256:'a'.repeat(64),reviewedEligible:3,falseEligible:0};
 expect(validVerifiedFirmAttestation(current)).toBe(true);
 expect(validVerifiedFirmAttestation({policyVersion:current.policyVersion,promptVersion:current.promptVersion,reportSha256:current.reportSha256,reviewedEligible:3,falseEligible:0})).toBe(false);
 for(const edit of [{policyVersion:'qualification-v4'},{verifiedFirmPolicyVersion:'verified-firm-v2'},{promptVersion:'qualification-growth-v6'},{verifiedFirmPolicyVersion:'verified-firm-v1'},{verifiedFirmPolicyVersion:'verified-firm-v0'},{promptVersion:'old'},{policyVersion:'old'},{reportSha256:'invalid'},{reviewedEligible:0},{falseEligible:1}])expect(validVerifiedFirmAttestation({...current,...edit})).toBe(false);
 expect(validVerifiedFirmAttestation(null)).toBe(false);
});
it.each([{region:'TX',locality:'Dallas'},{region:'RI',locality:'Newport'},{region:'MA',locality:'Worcester'}] as const)('verifies all-state $region fit without inventing maintenance pain',location=>{
 expect(verifiedFirmEvidence(evidence({...candidate,...location}))).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it.each([{firstParty:false},{truncated:true},{url:'https://directory.example.test/'},{retrievedAt:'2026-10-10T12:00:00.000Z'},{retrievedAt:'2026-10-19T12:00:00.000Z'}])('never verifies unusable source observation %j',edit=>{
 const input=evidence();input.observations[0]={...input.observations[0]!,...edit};
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'pending'});
});
it('does not use query/title geography, a directory, false citations or conflicting identity',()=>{
 const wrongArea=evidence({...candidate,locality:'Austin'});wrongArea.candidate=candidate;
 expect(verifiedFirmEvidence(wrongArea)).toEqual({kind:'unclear',reason:'identity_unresolved'});
 const directory=evidence({...candidate,website:'https://www.allpropertymanagement.com/dallas'});
 expect(verifiedFirmEvidence(directory)).toMatchObject({kind:'unclear'});
 const invented=evidence();invented.facts[0]={...invented.facts[0]!,value:'Invented Company'};
 expect(verifiedFirmEvidence(invented)).toEqual({kind:'pending',reason:'invalid_evidence'});
 const conflicting=evidence();conflicting.observations[0]!.blocks.push({id:'other',text:'Different Residential LLC'});conflicting.facts.push({kind:'firm_identity',value:'Different Residential LLC',observationId:conflicting.observations[0]!.id,blockId:'other'});
 expect(verifiedFirmEvidence(conflicting)).toEqual({kind:'unclear',reason:'firm_identity_ambiguous'});
});
it('keeps verified identity with missing, multiple or disconnected phones pending, never inferred',()=>{
 const missing=evidence();missing.facts=missing.facts.filter(f=>f.kind!=='business_phone');expect(verifiedFirmEvidence(missing)).toMatchObject({kind:'verified',phone:null});
 const multiple=evidence();multiple.observations[0]!.blocks.push({id:'second',text:`${candidate.firmName} (214) 555-0191`});multiple.facts.push({kind:'business_phone',value:multiple.observations[0]!.blocks[2]!.text,observationId:multiple.observations[0]!.id,blockId:'second'});expect(verifiedFirmEvidence(multiple)).toMatchObject({kind:'verified',phone:null});
 const distant=evidence();distant.observations[0]!.blocks.splice(1,0,...Array.from({length:5},(_,n)=>({id:`gap-${n}`,text:'Unrelated page section'})));expect(verifiedFirmEvidence(distant)).toMatchObject({kind:'verified',phone:null});
});
it('preserves branch paths and refuses unsupported query identities',()=>{
 expect(verifiedWebsiteKey('https://WWW.harbor.example.test/dallas/')).toBe('harbor.example.test/dallas');
 expect(verifiedWebsiteKey('https://harbor.example.test/austin')).not.toBe(verifiedWebsiteKey(candidate.website));
 expect(verifiedWebsiteKey('https://harbor.example.test/?office=a')).toBeNull();
 expect(verifiedWebsiteKey('https://harbor.example.test/?office=b')).toBeNull();
 expect(verifiedFirmEvidence(evidence({...candidate,website:'https://harbor.example.test/?office=a'}))).toMatchObject({kind:'pending'});
 expect(verifiedWebsiteKey('http://harbor.example.test')).toBeNull();
});
function literalOffice(texts:readonly string[],kinds:readonly (readonly [QualificationFact['kind'],number])[]){
 const input=evidence(),source=input.observations[0]!;
 source.blocks=texts.map((text,n)=>({id:`b${n}`,text}));
 input.facts=kinds.map(([kind,n])=>({kind,value:texts[n]!,observationId:source.id,blockId:`b${n}`}));return input;
}
it('never borrows a neighboring Austin office phone for the Dallas identity',()=>{
 const input=literalOffice(['Harbor Residential LLC provides residential property management.','Harbor Residential LLC office: Dallas, TX.','Harbor Residential LLC office: Austin, TX.','Contact Harbor Residential LLC Austin office: (512) 555-0190.'],[['firm_identity',0],['residential_management',0],['service_area',1],['business_phone',3]]);
 expect(verifiedFirmEvidence(input)).toEqual({kind:'unclear',reason:'phone_association_ambiguous'});
});
it('accepts a split same-office contact section without joining the next branch',()=>{
 const input=literalOffice(['Harbor Residential LLC provides residential property management.','Harbor Residential LLC Dallas office','Dallas, TX.','Contact Harbor Residential LLC at (214) 555-0190.','Harbor Residential LLC office: Austin, TX.'],[['firm_identity',0],['residential_management',0],['service_area',2],['business_phone',3]]);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it.each(['We do not manage residential properties. We manage commercial properties only.','We never manage residential homes.','We manage commercial properties exclusively.'])('keeps literal residential denial pending: %s',text=>{
 const input=literalOffice(['Harbor Residential LLC',text,'Harbor Residential LLC office: Dallas, TX. Contact Harbor Residential LLC (214) 555-0190.'],[['firm_identity',0],['residential_management',1],['service_area',2],['business_phone',2]]);
 expect(verifiedFirmEvidence(input)).toEqual({kind:'pending',reason:'residential_fit_unknown'});
});
it('does not let the model omit a literal contrary first-party residential statement',()=>{
 const input=evidence();input.observations[0]!.blocks.push({id:'contrary',text:'We do not manage residential properties.'});
 expect(verifiedFirmEvidence(input)).toEqual({kind:'pending',reason:'residential_fit_unknown'});
});
it.each(['selected','unselected'] as const)('refuses a %s original residences denial despite otherwise valid office proof',selection=>{
 const input=evidence(),source=input.observations[0]!;
 source.blocks.push({id:'residences',text:'We manage residences.'},{id:'contrary',text:'We do not manage residences.'});
 const residential=input.facts.find(f=>f.kind==='residential_management')!;
 residential.blockId=selection==='selected'?'contrary':'residences';residential.value=source.blocks.find(b=>b.id===residential.blockId)!.text;
 expect(verifiedFirmEvidence(input)).toEqual({kind:'pending',reason:'residential_fit_unknown'});
});
it('preserves legitimate managed residences with otherwise valid office proof',()=>{
 const input=evidence(),source=input.observations[0]!;
 source.blocks.push({id:'residences',text:'We manage residences.'});
 const residential=input.facts.find(f=>f.kind==='residential_management')!;residential.blockId='residences';residential.value='We manage residences.';
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it('enforces global20/650 modeled credit bounds and never reports a refund or invoice',()=>{
 expect(discoveryQuotaRemaining(19,649)).toEqual({daily:1,monthly:1});
 expect(discoveryQuotaRemaining(20,650)).toEqual({daily:0,monthly:0});
 expect(discoveryQuotaRemaining(33,700)).toEqual({daily:0,monthly:0});
 expect(discoveryQuotaRemaining(1,33,32)).toEqual({daily:19,monthly:0});
 expect(discoveryQuotaRemaining(-1,0)).toEqual({daily:0,monthly:0});
});
