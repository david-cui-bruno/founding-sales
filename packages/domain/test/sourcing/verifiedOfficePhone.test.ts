import {it,expect} from 'vitest';
import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import {verifiedFirmEvidence} from '../../sourcing/verifiedFirmPolicy.ts';
const now='2026-10-18T12:00:00.000Z',name='Cedar Residential LLC',phone='(214) 555-0190';
const candidate:CandidateInput={firmName:name,website:'https://cedar.example.test/dallas',sourceUrl:'https://cedar.example.test/dallas',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Unverified search',preparedBy:'Tavily Basic search · not verified',observedOn:'2026-10-18'};
/** Fictional data, real extraction shape: a fact contains exactly one original block. */
function fixture(card:readonly string[],phoneIndices:readonly number[]=[1]){
 const texts=[...card,`${name} provides residential property management.`,`We serve ${candidate.locality}, ${candidate.region}.`];
 const observation:SourceObservation={id:'00000000-0000-4000-8000-000000000001',url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:texts.map((text,n)=>({id:`b${n}`,text}))};
 const selected:readonly (readonly [QualificationFact['kind'],number])[]=[['firm_identity',card.length],['residential_management',card.length],['service_area',card.length+1],...phoneIndices.map(index=>['business_phone',index] as const)];
 const facts:QualificationFact[]=selected.map(([kind,index])=>({kind,value:texts[index]!,observationId:observation.id,blockId:`b${index}`}));
 return {candidate:{...candidate},observations:[observation],facts,now};
}
it.each([
 [name,phone,'100 Properties Managed','Dallas, TX'],
 [name,phone,'100 Properties Managed, Dallas, TX'],
 [name,phone,'214 555 0190 reference 123','Dallas, TX'],
].map(card=>({card})))('does not use numeric marketing prose as physical address proof: $card',({card})=>{
 expect(verifiedFirmEvidence(fixture(card))).toMatchObject({kind:'verified',phone:null});
});
it.each(['214 555 0190123','214 555 0190 reference 123','1214 555 0190123','x214 555 0190','214 555 0190x'])('requires a complete recognized selected phone production: %s',value=>{
 expect(verifiedFirmEvidence(fixture([name,value,'Office Location','Dallas, TX']))).toMatchObject({kind:'verified',phone:null});
});
it.each(['12 Example Street','42 N Example Ave.','125 Example Boulevard Suite 2'])('retains genuine split and inline address proof: %s',address=>{
 expect(verifiedFirmEvidence(fixture([name,phone,address,'Dallas, TX']))).toMatchObject({kind:'verified',phone:'+12145550190'});
 expect(verifiedFirmEvidence(fixture([name,phone,`${address}, Dallas, TX`]))).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it('retains a selected phone inside a single explicit office declaration',()=>{
 const text=`${name} office: Dallas, TX. We provide residential property management. Contact ${name} at ${phone}.`;
 expect(verifiedFirmEvidence(fixture([text],[0]))).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it('refuses a no-comma foreign physical address instead of combining it with the target city',()=>{
 const card=[name,'Office Location','12 Example Street Austin TX 78701','Dallas, TX',phone];
 expect(verifiedFirmEvidence(fixture(card,[4]))).not.toMatchObject({phone:'+12145550190'});
});
it.each([
 [name,'Office Location','12 Example Street','Dallas, TX',phone,'Austin, TX'],
 [name,'Office Location','12 Example Street','Dallas, TX','Austin, TX',phone],
 [name,'Office Location','12 Example Street','Dallas, TX',phone,'(214) 555-0191'],
 [name,'Office Location','12 Example Street','Dallas, TX',phone,'Office:','(214) 555-0191'],
].map(card=>({card})))('does not discard contrary continuation from the compact office section: $card',({card})=>{
 expect(verifiedFirmEvidence(fixture(card,[card.indexOf(phone)]))).not.toMatchObject({phone:'+12145550190'});
});
it('accepts a generic colon office label without mistaking it for foreign identity evidence',()=>{
 expect(verifiedFirmEvidence(fixture([name,'Office:',phone,'12 Example Street','Dallas, TX'],[2]))).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it.each(['Austin Office','Austin Office:'])('recognizes explicit foreign branch independent of punctuation: %s',heading=>{
 expect(verifiedFirmEvidence(fixture([name,heading,phone],[2]))).toEqual({kind:'unclear',reason:'phone_association_ambiguous'});
});
const compact=[name,phone,'office@cedar.example.test','Office Location','12 Example Street','Dallas TX 75001'];
it('accepts literal bare phone with its name/address in the same six-block office card without mutating citations',()=>{
 const input=fixture(compact),before=JSON.stringify(input);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:'+12145550190'});
 expect(JSON.stringify(input)).toBe(before);expect(input.facts.find(f=>f.kind==='business_phone')?.value).toBe(phone);
});
it('accepts source-start phone/address/email/name without treating the matching address as another office',()=>{
 const input=fixture([phone,'12 Example Street, Dallas, TX 75001','office@cedar.example.test',name],[0]);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it('accepts name/street/city/phone and repeated citations for the same number',()=>{
 const input=fixture([name,'12 Example Street','Dallas, Texas 75001',phone,phone],[3,4]);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:'+12145550190'});
});
it('does not let a service-area fact turn an office in a different city into the target office',()=>{
 const input=fixture([name,phone,'Office Location','12 Example Street','Austin, TX 78701']);
 expect(verifiedFirmEvidence(input)).not.toMatchObject({phone:'+12145550190'});
});
it.each([
 [name,'Dallas, TX',`${name} office: Austin, TX.`,phone],
 [name,'Dallas, TX',phone,`${name} office: Austin, TX.`,phone],
 [`${name} office: Austin, TX.`,phone,'Dallas, TX',name],
 [name,'Dallas, TX','Other Residential LLC','Austin, TX',phone],
 [name,'Dallas, TX','12 Other Street, Austin, TX',phone],
 [name,'Dallas, TX','12 Other Street, Austin, Texas',phone],
 [name,'12 First Street','Dallas, TX','12 Second Street',phone],
 [name,'12 Other Street, Austin, TX, Dallas, TX',phone],
].map(card=>({card})))('never stitches neighboring or contradictory branch cards: $card',({card})=>{
 const input=fixture(card,[card.lastIndexOf(phone)]);
 expect(verifiedFirmEvidence(input)).not.toMatchObject({phone:'+12145550190'});
});
it.each([
 [name,phone,'About our great team','Dallas, TX'],
 [name,phone,'See our other office','Dallas, TX'],
 [name,phone,...Array.from({length:6},()=> 'Office'),'Dallas, TX'],
 [name,phone,'Office Location','Austin, TX','Dallas, TX'],
 [name,phone,'Powered by Another Company','Dallas, TX'],
].map(card=>({card})))('refuses unrelated, over-eight-block or foreign-location context: $card',({card})=>{
 expect(verifiedFirmEvidence(fixture(card))).not.toMatchObject({phone:'+12145550190'});
});
it('requires physical-office evidence rather than a nearby named service-area statement',()=>{
 const input=fixture([`${name} provides residential property management in Dallas, TX.`,phone]);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:null});
 const cityOnly=fixture([name,phone,'Dallas, TX']);expect(verifiedFirmEvidence(cityOnly)).toMatchObject({kind:'verified',phone:null});
});
it('accepts the eight-block boundary while refusing nine, and keeps service-town/office-town distinct',()=>{
 const input=fixture([name,phone,'office@cedar.example.test','Office Location','12 Example Street','Suite 2','Contact Information','Dallas, TX']);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:'+12145550190'});
 const nine=fixture([name,phone,'office@cedar.example.test','Office Location','12 Example Street','Suite 2','Contact Information','Office Address','Dallas, TX']);
 expect(verifiedFirmEvidence(nine)).not.toMatchObject({phone:'+12145550190'});
 const serviceTown=fixture([name,phone,'Office Location','12 Example Street','Boston, MA 02135']);
 serviceTown.candidate.locality='Somerville';serviceTown.candidate.region='MA';
 const source=serviceTown.observations[0]!,fact=serviceTown.facts.find(f=>f.kind==='service_area')!;
 source.blocks.find(block=>block.id===fact.blockId)!.text='We serve Somerville, Massachusetts.';fact.value='We serve Somerville, Massachusetts.';
 expect(verifiedFirmEvidence(serviceTown)).not.toMatchObject({phone:'+12145550190'});
});
it('does not combine a company heading on one observation with another page phone/address',()=>{
 const input=fixture([name,phone]);
 const other={...input.observations[0]!,id:'00000000-0000-4000-8000-000000000002',blocks:[{id:'city',text:'Dallas, TX'}]};
 input.observations.push(other);expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:null});
});
it.each(['Fax:','After Hours Emergency:','Powered by Web Design:'])('does not promote a %s number into a business office phone',prefix=>{
 expect(verifiedFirmEvidence(fixture([name,`${prefix} ${phone}`,'Dallas, TX']))).toMatchObject({kind:'verified',phone:null});
});
it('refuses multiple selected numbers, even if only one has a compact target-office card',()=>{
 const input=fixture([...compact,'Contact the other office at (512) 555-0191'],[1,6]);
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'verified',phone:null});
});
it('refuses an unselected second number within the proposed card',()=>{
 expect(verifiedFirmEvidence(fixture([name,phone,'(214) 555-0191','Dallas, TX']))).toMatchObject({kind:'verified',phone:null});
});
it('does not normalize an SEO title to a company name or ignore conflicting firm-identity facts',()=>{
 const seo=fixture(compact);seo.candidate.firmName='Dallas Property Management | Cedar Residential LLC';
 expect(verifiedFirmEvidence(seo)).toEqual({kind:'unclear',reason:'firm_identity_ambiguous'});
 const conflict=fixture(compact),source=conflict.observations[0]!;source.blocks.push({id:'other',text:'Other Residential LLC'});
 conflict.facts.push({kind:'firm_identity',value:'Other Residential LLC',blockId:'other',observationId:source.id});
 expect(verifiedFirmEvidence(conflict)).toEqual({kind:'unclear',reason:'firm_identity_ambiguous'});
});
it.each([{firstParty:false},{truncated:true},{retrievedAt:'2026-10-10T12:00:00Z'},{url:'https://other.example.test/contact'}])('does not borrow unusable complete-card evidence %j',edit=>{
 const input=fixture(compact);input.observations[0]={...input.observations[0]!,...edit};
 expect(verifiedFirmEvidence(input)).toMatchObject({kind:'pending'});
});
it('refuses forged phone values and retains literal residential negative evidence',()=>{
 const forged=fixture(compact);forged.facts.find(f=>f.kind==='business_phone')!.value='(214) 555-0191';
 expect(verifiedFirmEvidence(forged)).toEqual({kind:'pending',reason:'invalid_evidence'});
 const denied=fixture(compact);denied.observations[0]!.blocks.push({id:'denied',text:'We do not manage residential properties. Commercial only.'});
 expect(verifiedFirmEvidence(denied)).toEqual({kind:'pending',reason:'residential_fit_unknown'});
});
