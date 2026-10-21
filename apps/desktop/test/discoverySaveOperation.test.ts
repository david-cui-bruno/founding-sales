import {describe,expect,it} from 'vitest';
import {sourcingDiscoverySaveOperation} from '../src/shared/sourcingDiscoverySaveOperation.ts';

const operation=sourcingDiscoverySaveOperation['sourcing.discoverySave'];
function input() {
  const source={provider:'overture_places',recordId:'record-1',release:'2026-09-23.1',retrievedAt:null,sourceUrl:'https://example.org/places.parquet'};
  return {commandId:'discovery_batch_1:record_1',
    row:{source,observations:[source],firmName:'Example Property Management',website:null,locality:null,region:'CA',sourceConfidence:0.9,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'observed_source',probableGroupKey:null},
    origins:[{source,sourceMetadata:{sourcesJson:'[{"dataset":"meta"}]'},licenses:['CDLA-Permissive-2.0'],notices:[{label:'License',url:'https://example.org/license',sha256:'a'.repeat(64)}]}]};
}

describe('explicit raw discovery save operation',()=>{
  it('declares only the existing single-entry command endpoint',()=>{
    expect(operation.kind).toBe('command');
    expect(operation.calls).toEqual([{method:'POST',path:'/sourcing/candidates/discovery/save-v1'}]);
  });
  it('preserves nullable nationwide observations and stable non-UUID command IDs',()=>{
    const value=input();expect(operation.input.parse(value)).toEqual(value);
    expect(operation.input.safeParse({...value,row:{...value.row,website:'http://example.org/?observed=1'}}).success).toBe(true);
  });
  it('refuses caller-owned identity/version, claimed fit and source drift',()=>{
    const value=input();
    for(const extra of [{workspaceId:'other'},{clientVersion:'1.0.56'},{actorId:'other'},{body:'private'}]) {
      expect(operation.input.safeParse({...value,...extra}).success).toBe(false);
    }
    expect(operation.input.safeParse({...value,row:{...value.row,residentialFit:'supported'}}).success).toBe(false);
    expect(operation.input.safeParse({...value,origins:[]}).success).toBe(false);
    expect(operation.input.safeParse({...value,commandId:'unsafe/id'}).success).toBe(false);
  });
  it('keeps actual save acknowledgments separate from refusal and authority',()=>{
    expect(operation.output.parse({result:null,reason:'not_authorized'})).toEqual({result:null,reason:'not_authorized'});
    const result={id:'11111111-1111-4111-8111-111111111111',revision:1,exactDuplicates:0,observationsAttached:1,newlyPersisted:1};
    expect(operation.output.parse({result,reason:null}).result).toEqual(result);
    expect(operation.output.safeParse({result:{...result,runtimeCallable:true},reason:null}).success).toBe(false);
  });
});
