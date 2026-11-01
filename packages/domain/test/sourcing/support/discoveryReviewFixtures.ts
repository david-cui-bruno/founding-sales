import type {DiscoveryReviewInput} from '@fss/contracts';
import type {DiscoverySeed} from './discoverySeed.ts';

/** Public-business excerpts copied from the retained October 21 slice, never fetched
 * by tests. Original provenance is preserved here. Tests explicitly use a relative
 * synthetic clock for freshness mechanics, not a claim of another retrieval. */
export const retainedDiscoveryExcerpts=[
  {firmName:'Tree Realty',recordId:'28ff4bbf-3596-4ce7-a6ab-92d5ae0dea2f',release:'2026-09-23.1',url:'https://www.treerealtor.com',contentHash:'1df9a012e6a2c3b8736e456d9895a66b2e3a20384c82c0cb039ab13e5b59f824',retrievedAt:'2026-10-21T03:32:55.090Z',blockId:'b16',kind:'paragraph' as const,text:'managing, leasing & selling of residential Real Estate in Austin and the Central Texas area'},
  {firmName:'Implicity Management',recordId:'ee030193-0c36-4ca6-8751-8ed6e25e3dc4',release:'2026-09-23.1',url:'https://implicitymanagement.com',contentHash:'9132838c1eec1e43072ddd915ca1f56c89c6bbd3faf0607706c0168000d9e8a5',retrievedAt:'2026-10-21T03:33:00.071Z',blockId:'b3',kind:'paragraph' as const,text:'Management Company is a Multi-Family Property Management Company Supporting South Texas'},
  {firmName:'Crosstown Properties',recordId:'00c59043-a3e2-4527-97e4-2d78522e735c',release:'2026-09-23.1',url:'https://austinlandlord.com/',contentHash:'fb68f6b4742bbb864091b29549ca3c8385456ffbaa2d3d53c812a56bef55db0c',retrievedAt:'2026-10-21T03:32:59.756Z',blockId:'b29',kind:'heading' as const,text:'Residential Property Management'},
] as const;
export function discoveryReviewCandidate(index=0,recordSuffix=''):DiscoverySeed {
  const fixture=retainedDiscoveryExcerpts[index]!;
  const source={provider:'overture_places' as const,recordId:fixture.recordId+recordSuffix,release:fixture.release,retrievedAt:null,sourceUrl:'https://example.test/provider'};
  return {row:{source,observations:[source],firmName:fixture.firmName,website:fixture.url,locality:null,region:null,sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['Test fixture only'],notices:[{label:'Retained excerpt test fixture, not provider import',url:'https://example.test/notice',sha256:'a'.repeat(64)}]}]};
}
export function discoveryHumanReview(candidateId:string,index=0,recordSuffix=''):DiscoveryReviewInput {
  const fixture=retainedDiscoveryExcerpts[index]!;
  return {candidateId,expectedRevision:1,reviewVersion:'discovery-review-v1',evidence:[{source:{provider:'overture_places',release:fixture.release,recordId:fixture.recordId+recordSuffix},url:fixture.url,contentHash:fixture.contentHash,retrievedAt:new Date(Date.now()-60_000).toISOString(),completeness:'unknown',association:'unknown',basis:'retained_excerpt',blocks:[{blockId:fixture.blockId,kind:fixture.kind,text:fixture.text}]}],assessment:{serviceSignal:fixture.kind==='paragraph'?'paragraph_supported':'tentative',websiteAssociation:'unknown',unknowns:['firm_identity_unknown','first_party_completeness_unknown','legal_clearance_unknown','fit_not_qualified']}};
}
