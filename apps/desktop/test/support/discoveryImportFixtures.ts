import type {DiscoveryIntakeSaveInput} from '@fss/contracts';
import type {OperationOutput} from '../../src/shared/operations.ts';
export function rawDiscoveryEntry(recordId='record-1'):DiscoveryIntakeSaveInput {
  const source={provider:'overture_places' as const,recordId,release:'2026-09-23.1',retrievedAt:null,sourceUrl:'https://example.test/raw?original=1'};
  return {
    row:{source,observations:[source],firmName:'Synthetic Property Management',website:null,locality:null,region:null,sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'observed_source',probableGroupKey:null},
    origins:[{source,sourceMetadata:{sourcesJson:'[{"dataset":"synthetic","record_id":"original-id"}]'},licenses:['CDLA-Permissive-2.0'],notices:[{label:'<script>Inert notice</script>',url:'https://example.test/notice?original=1',sha256:'a'.repeat(64)}]}],
  };
}
export const discoveryReceipt={id:'11111111-1111-4111-8111-111111111111',revision:1,exactDuplicates:0,observationsAttached:1,newlyPersisted:1};
export function listedDiscovery(entry=rawDiscoveryEntry(),index=1,status:'needs_review'|'kept'|'dismissed'='needs_review'):NonNullable<OperationOutput<'sourcing.discoveryList'>['view']>['candidates'][number] {
  return {id:`11111111-1111-4111-8111-${index.toString().padStart(12,'0')}`,status,revision:1,createdAt:'2026-10-01T00:00:00Z',payload:{kind:'discovery-v1',row:entry.row},origins:entry.origins};
}
export const emptyDiscoveryList={view:{candidates:[],hasMore:false},reason:null};
