import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {candidateInputSchema,currentPreparedCandidateInputSchema,legacyCandidateInputSchema,targetingQuerySchema,type QualificationFact,type SourceObservation} from '@fss/contracts';
import {US_BUSINESS_REGIONS,US_BUSINESS_STATE_NAMES} from '../../../contracts/src/usBusinessGeography.ts';
import {isCurrentUSBusinessGeography,currentNativeFirmPolicy,supportsCurrentUSServiceLocation} from '../../sourcing/currentUSBusinessGeography.ts';
import {isCurrentPreparedCandidatePayload,isLegacyCandidatePayload} from '../../sourcing/discoveryIntake.ts';
import {nativeFirmCitations,nativeFirmEvidence,type NativeEvidenceInput} from '../../sourcing/nativeFirmEligibility.ts';
import {verifiedFirmEvidence} from '../../sourcing/verifiedFirmPolicy.ts';
import {isTargetGeography} from '../../sourcing/qualificationPolicy.ts';

const id='00000000-0000-4000-8000-000000000001',now='2026-10-29T08:00:00.000Z';
function input(region:NativeEvidenceInput['candidate']['region']='CA',locality='Los Angeles',text?:string):NativeEvidenceInput {
 const candidate={firmName:'Synthetic Harbor LLC',website:'https://harbor.example.test/',region,locality};
 const value=text??`${candidate.firmName} provides residential property management in ${locality}, ${US_BUSINESS_STATE_NAMES[region]}.`;
 const observations:SourceObservation[]=[{id,url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),
  retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text:value}]}];
 const facts:QualificationFact[]=(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value,observationId:id,blockId:'native'}));
 return {candidate,now,facts,observations};
}
const candidate=(region='CA')=>({firmName:'Synthetic Harbor LLC',website:'https://harbor.example.test/',sourceUrl:'https://harbor.example.test/',
 region,locality:'Los Angeles',signal:'fit_only',evidence:'Retained exact source',preparedBy:'Current approved search',observedOn:'2026-10-29'});
it('defines fifty states plus DC while unknown and non-US regions remain held',()=>{
 expect(US_BUSINESS_REGIONS).toHaveLength(51);expect(new Set(US_BUSINESS_REGIONS).size).toBe(51);
 for(const region of US_BUSINESS_REGIONS)expect(isCurrentUSBusinessGeography(region,'Current city')).toBe(true);
 for(const region of ['ON','BC','QC','PR','GU','US','ZZ','ca',''])expect(isCurrentUSBusinessGeography(region,'Current city')).toBe(false);
 for(const locality of ['','   ','\t'])expect(isCurrentUSBusinessGeography('CA',locality)).toBe(false);
});
it('accepts added US candidates through current intake but never through frozen legacy calling/admission guards',()=>{
 const value=candidate();expect(currentPreparedCandidateInputSchema.safeParse(value).success).toBe(true);
 expect(candidateInputSchema.safeParse(value).success).toBe(true);expect(isCurrentPreparedCandidatePayload(value)).toBe(true);
 expect(targetingQuerySchema.safeParse({id:'current-us-fixture',query:'Los Angeles residential property management',region:'CA',locality:'Los Angeles'}).success).toBe(true);
 expect(legacyCandidateInputSchema.safeParse(value).success).toBe(false);expect(isLegacyCandidatePayload(value)).toBe(false);
 for(const region of ['TX','RI','MA'])expect(isLegacyCandidatePayload(candidate(region))).toBe(true);
 for(const region of ['ON','PR','ZZ'])expect(isCurrentPreparedCandidatePayload(candidate(region))).toBe(false);
});
it.each(US_BUSINESS_REGIONS)('requires full first-party city/state evidence for current %s coverage with a derived policy',region=>{
 const value=input(region,'Testville'),proof=nativeFirmCitations(value);
 expect(proof).toHaveProperty('citations');
 expect(proof).toHaveProperty('policyVersion',region==='TX'?'native-firm-eligibility-v1':'native-firm-eligibility-us-v1');
 expect(currentNativeFirmPolicy(region,'Testville')).toBe(region==='TX'?'native-firm-eligibility-v1':'native-firm-eligibility-us-v1');
});
it.each([['TX','Dallas'],['RI','Providence'],['MA','Boston']] as const)('preserves exact %s/%s legacy evidence and policy behavior', (region,locality)=>{
 const value=input(region,locality,`Synthetic Harbor LLC provides residential property management in ${locality}, ${region}.`);
 expect(isTargetGeography(region,locality)).toBe(true);expect(nativeFirmEvidence(value)).toMatchObject({kind:'verified'});
 expect(verifiedFirmEvidence(value)).toMatchObject({kind:'verified',phone:null});
 expect(nativeFirmCitations(value)).toHaveProperty('policyVersion','native-firm-eligibility-v1');
});
it('does not reinterpret the default legacy evidence core or old target policy as nationwide authority',()=>{
 const value=input();expect(isTargetGeography('CA','Los Angeles')).toBe(false);
 expect(nativeFirmEvidence(value)).not.toMatchObject({kind:'verified'});expect(verifiedFirmEvidence(value)).not.toMatchObject({kind:'verified'});
 expect(nativeFirmCitations(value)).toHaveProperty('policyVersion','native-firm-eligibility-us-v1');
});
it('supports previously excluded RI locality only through full-state current evidence and the new policy',()=>{
 expect(isTargetGeography('RI','Newport')).toBe(false);
 expect(nativeFirmCitations(input('RI','Newport'))).toHaveProperty('policyVersion','native-firm-eligibility-us-v1');
 expect(nativeFirmCitations(input('RI','Newport','Synthetic Harbor LLC provides residential property management in Newport, RI.'))).toMatchObject({status:'unavailable'});
});
it.each([
 'Synthetic Harbor LLC provides residential property management in Toronto, CA.',
 'Synthetic Harbor LLC provides residential property management in Toronto, Ontario.',
 'Synthetic Harbor LLC provides residential property management in Toronto, California, Canada.',
 'Synthetic Harbor LLC provides residential property management in Los Angeles, Oregon.',
 'Synthetic Harbor LLC provides residential property management in Los Angeles, California and Los Angeles, Oregon.',
 'Synthetic Harbor LLC does not provide residential property management in Los Angeles, California.',
 'Synthetic Harbor LLC could provide residential property management in Los Angeles, California.',
 'Synthetic Harbor LLC previously provided residential property management in Los Angeles, California.',
])('holds non-US, mismatched, contradictory or conditional new-coverage evidence: %s',text=>{
 const locality=text.includes('Toronto')?'Toronto':'Los Angeles';
 expect(supportsCurrentUSServiceLocation(text,'CA',locality)).toBe(false);
 expect(nativeFirmCitations(input('CA',locality,text))).toMatchObject({status:'unavailable',channelAuthority:'not_granted'});
});
it.each(['may provide','plans to provide','intends to provide','will provide','would provide','is planning to provide','is going to provide','expects to provide'])('holds future or conditional US service claims despite literal city/full-state and all three native roles: %s',action=>{
 const text=`Synthetic Harbor LLC ${action} residential property management in Los Angeles, California.`;
 expect(supportsCurrentUSServiceLocation(text,'CA','Los Angeles')).toBe(false);
 expect(nativeFirmCitations(input('CA','Los Angeles',text))).toMatchObject({status:'unavailable',channelAuthority:'not_granted'});
});
it('does not count a state-name mention as both the locality and state, but accepts an explicit pair',()=>{
 expect(nativeFirmCitations(input('NY','New York','Synthetic Harbor LLC provides residential property management in New York.'))).toMatchObject({status:'unavailable'});
 expect(nativeFirmCitations(input('NY','New York'))).toHaveProperty('policyVersion','native-firm-eligibility-us-v1');
 expect(nativeFirmCitations(input('DC','Washington'))).toHaveProperty('policyVersion','native-firm-eligibility-us-v1');
 expect(nativeFirmCitations(input('CA','Ontario'))).toHaveProperty('policyVersion','native-firm-eligibility-us-v1');
});
it.each([{firstParty:false},{truncated:true},{url:'https://foreign.example.test/'},{retrievedAt:'2026-11-01T08:00:00.000Z'},
 {retrievedAt:'2026-10-22T08:00:00.000Z'}])('does not loosen existing source/host/expiry fences for new coverage %j',edit=>{
 const value=input();Object.assign(value.observations[0]!,edit);expect(nativeFirmCitations(value)).toMatchObject({status:'unavailable'});
});
it('migration adds explicit immutable version metadata without rewriting existing business rows',()=>{
 const sql=readFileSync(new URL('../../db/migrations/0147_current_us_prepared_supply.sql',import.meta.url),'utf8');
 expect(sql).toContain("DEFAULT 'native-firm-eligibility-v1'");
 expect(sql).toContain("IN ('native-firm-eligibility-v1','native-firm-eligibility-us-v1')");
 expect(sql).toContain('NEW.native_policy_version IS DISTINCT FROM OLD.native_policy_version');
 expect(sql).not.toMatch(/\b(?:UPDATE|DELETE FROM)\s+sourcing_automatic_research_firms\b/iu);
});
