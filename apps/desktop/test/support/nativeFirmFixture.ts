import type {QualificationView} from '@fss/contracts';
export const nativeId='11111111-1111-4111-8111-111111111111';
export function nativeView(now=new Date().toISOString(),ttl=60000):QualificationView {
 const text='Synthetic Harbor LLC provides residential property management in Dallas, TX.';
 const citations=(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,observationId:nativeId,blockId:'native'}));
 return {candidateId:nativeId,runId:nativeId,candidateRevision:2,status:'review',reason:null,admissionReason:'business_phone_unresolved',requestedAt:now,deadlineAt:new Date(Date.parse(now)+60000).toISOString(),observations:[{id:nativeId,url:'https://synthetic.example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text}]}],facts:citations.map(c=>({...c,value:text})),verdict:null,openingQuestion:null,admission:null,history:[],nativeEligibility:{status:'verified',policyVersion:'native-firm-eligibility-v1',promotionId:nativeId,discoveryCandidateId:nativeId,discoveryRevision:1,candidateId:nativeId,candidateRevision:2,runId:nativeId,firmId:nativeId,ownerUserId:nativeId,checkedAt:now,validUntil:new Date(Date.parse(now)+ttl).toISOString(),citations,channelAuthority:'not_granted'}};
}
