import type {CandidateInput} from '@fss/contracts';
import type {DiscoverySeed} from './discoverySeed.ts';
export function manualDiscoveryFixture(recordId='manual-1'):DiscoverySeed{
 const source={provider:'overture_places' as const,recordId,release:'manual-fixture',retrievedAt:null,sourceUrl:`https://source.example.test/${recordId}`};
 return {row:{source,observations:[source],firmName:`Unverified ${recordId}`,website:null,locality:null,region:null,sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null},
 origins:[{source,sourceMetadata:{sourcesJson:'[]'},licenses:['CDLA-Permissive-2.0'],notices:[{label:'Retained synthetic notice',url:'https://source.example.test/license',sha256:'a'.repeat(64)}]}]};
}
export function manualOrdinaryFixture(index=1):CandidateInput{
 return {firmName:`Ordinary unverified ${index}`,website:`https://ordinary-${index}.example.test/`,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Loose-fit retained observation only. No phone or need evaluation.',sourceUrl:`https://source.example.test/ordinary-${index}`,observedOn:'2026-10-20',preparedBy:'Synthetic manual acceptance'};
}
