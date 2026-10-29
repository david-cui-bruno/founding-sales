import {expect,it} from 'vitest';
import type {QualificationFact,SourceObservation} from '@fss/contracts';
import {currentUSPreparedEmailFit} from '../../sourcing/currentPreparedEmailFit.ts';
import {nativeFirmCitations,type NativeEvidenceInput} from '../../sourcing/nativeFirmEligibility.ts';
import {qualifyEmailCandidate,supportedBusinessEmail} from '../../outreach/selection.ts';
const id='00000000-0000-4000-8000-000000000001',emailId='00000000-0000-4000-8000-000000000002';
function input(action='provides'):NativeEvidenceInput {
 const candidate={firmName:'Synthetic Harbor LLC',website:'https://harbor.example.test/',region:'CA' as const,locality:'Los Angeles'};
 const now='2026-10-29T08:00:00.000Z';
 const text=`Synthetic Harbor LLC ${action} residential property management in Los Angeles, California.`;
 const email='Contact Synthetic Harbor LLC office in Los Angeles, CA at info@harbor.example.test.';
 const native:SourceObservation={id,url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,
  publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text}]};
 const observations=[native,{...native,id:emailId,blocks:[{id:'email',text:email}]}];
 const facts:QualificationFact[]=[...(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value:text,observationId:id,blockId:'native'})),
  {kind:'business_email',value:email,observationId:emailId,blockId:'email'}];
 return {candidate,now,facts,observations};
}
it('derives prepared email fit only after same-input us-v1 native proof, without relabeling legacy email-fit-v2',()=>{
 const value=input(),native=nativeFirmCitations(value);
 const legacy=qualifyEmailCandidate({identity:{status:'resolved',name:value.candidate.firmName,website:value.candidate.website,
  region:value.candidate.region,locality:value.candidate.locality},facts:value.facts,observations:value.observations,now:value.now});
 expect(legacy).toMatchObject({decision:'review',policyVersion:'outreach-email-fit-v2',unknowns:['target_geography_unsupported']});
 expect(currentUSPreparedEmailFit(value,native)).toMatchObject({eligible:true,route:{address:'info@harbor.example.test'},channelAuthority:'not_granted'});
 expect(legacy.decision).toBe('review');expect(currentUSPreparedEmailFit(value,native)).not.toHaveProperty('policyVersion');
});
it.each(['may provide','plans to provide','intends to provide','will provide','would provide','is planning to provide','is going to provide','expects to provide'])('refuses future or conditional service proof with an independently valid office email: %s',action=>{
 const value=input(action),native=nativeFirmCitations(value);
 expect(supportedBusinessEmail({identity:{status:'resolved',name:value.candidate.firmName,website:value.candidate.website,
  region:value.candidate.region,locality:value.candidate.locality},facts:value.facts,observations:value.observations,now:value.now}))
  .toMatchObject({address:'info@harbor.example.test',sourceObservationId:emailId});
 expect(native).toMatchObject({status:'unavailable'});
 expect(currentUSPreparedEmailFit(value,native)).toEqual({eligible:false,route:null,channelAuthority:'not_granted'});
});
it.each(['missing','unavailable','foreign','expiry','old policy'] as const)('refuses %s native proof instead of stripping a reason generically',change=>{
 const value=input(),native=nativeFirmCitations(value);
 let proof:unknown=native;
 if(change==='missing')proof=null;
 if(change==='unavailable')proof={status:'unavailable',reason:'geography_unsupported',channelAuthority:'not_granted'};
 if(change==='foreign')proof={...native,citations:[{kind:'service_area',observationId:emailId,blockId:'email'}]};
 if(change==='expiry')proof={...native,validUntil:'2027-01-01T00:00:00.000Z'};
 if(change==='old policy')proof={...native,policyVersion:'native-firm-eligibility-v1'};
 expect(currentUSPreparedEmailFit(value,proof)).toEqual({eligible:false,route:null,channelAuthority:'not_granted'});
});
it.each(['geography','source','facts','expiry','route missing','route foreign','consumer route'] as const)('keeps %s loss held despite a formerly valid current native proof',change=>{
 const value=input(),native=nativeFirmCitations(value);
 if(change==='geography')value.candidate.locality='San Francisco';
 if(change==='source')Object.assign(value.observations[0]!,{firstParty:false});
 if(change==='facts')value.facts[0]!.value='Synthetic Harbor LLC';
 if(change==='expiry')value.now='2026-11-05T08:00:00.000Z';
 if(change==='route missing')value.facts=value.facts.filter(fact=>fact.kind!=='business_email');
 if(change==='route foreign')Object.assign(value.observations[1]!,{url:'https://foreign.example.test/'});
 if(change==='consumer route'){
  const text='Contact Synthetic Harbor LLC office in Los Angeles, CA at info@gmail.com.';
  value.facts.find(fact=>fact.kind==='business_email')!.value=text;value.observations[1]!.blocks[0]!.text=text;
 }
 expect(currentUSPreparedEmailFit(value,native)).toEqual({eligible:false,route:null,channelAuthority:'not_granted'});
});
