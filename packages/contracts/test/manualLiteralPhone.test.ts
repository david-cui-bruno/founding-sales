import {describe, expect, it} from 'vitest';
import {manualProspectPhoneEvidenceSchema} from '../src/manualProspects.ts';
import {manualLiteralPhoneSourceSchema} from '../src/manualLiteralPhone.ts';
const id='b385612c-cac8-43a3-a72d-fc2dd7d8553d';
const source={method:'retained_original_literal', runId:id, observationId:id, blockId:'b1',
  url:'https://example.test/contact', retrievedAt:'2026-10-24T17:00:00.000Z',
  contentHash:'a'.repeat(64), relevantTextHash:'b'.repeat(64), parser:'manual-literal-phone-v1',
  literal:'(214) 555-0123',start:7,end:21,label:'Phone',labelStart:0,labelEnd:5,
  normalizedValue:'+12145550123',normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',
  authority:{kind:'candidate_source',sourceUrl:'https://example.test/contact'},lineage:{kind:'provider_original'}};
const coverage={parser:'manual-literal-phone-v1',state:'complete',observations:1,blocks:1};
describe('manual literal phone boundary',()=>{
  it('accepts exact bounded provenance without replacing legacy fact sources',()=>{
    expect(manualLiteralPhoneSourceSchema.safeParse(source).success).toBe(true);
    expect(manualProspectPhoneEvidenceSchema.safeParse({state:'observed',value:source.normalizedValue,sources:[source],coverage}).success).toBe(true);
    const legacy={runId:id,observationId:id,blockId:'b1',url:source.url,retrievedAt:source.retrievedAt};
    expect(manualProspectPhoneEvidenceSchema.safeParse({state:'observed',value:source.normalizedValue,sources:[legacy]}).success).toBe(true);
  });
  it('rejects invented or incomplete spans, hashes and authority',()=>{
    for(const change of [{end:20},{labelEnd:4},{start:-1},{contentHash:'bad'},
      {authority:{kind:'same_host'}},{lineage:{kind:'retained_interpretation',originalRunId:id}},
      {originalBody:'not permitted in list'},{parser:'model_extraction'}])
      expect(manualLiteralPhoneSourceSchema.safeParse({...source,...change}).success).toBe(false);
  });
  it('requires complete coverage and matching endpoint for every selected literal',()=>{
    const base={state:'observed',value:source.normalizedValue,sources:[source],coverage};
    for(const state of ['changed','unavailable','bounded'])
      expect(manualProspectPhoneEvidenceSchema.safeParse({...base,coverage:{...coverage,state}}).success).toBe(false);
    expect(manualProspectPhoneEvidenceSchema.safeParse({...base,coverage:undefined}).success).toBe(false);
    expect(manualProspectPhoneEvidenceSchema.safeParse({...base,coverage:{...coverage,observations:0}}).success).toBe(false);
    expect(manualProspectPhoneEvidenceSchema.safeParse({...base,value:'+12145550124'}).success).toBe(false);
  });
  it('preserves unsupported potentially relevant literals as conflict, never a winner',()=>{
    const unresolved={...source,normalizedValue:null,normalizationBasis:'unsupported'};
    expect(manualProspectPhoneEvidenceSchema.safeParse({state:'conflicting',reason:'unresolved_retained_literal',sources:[unresolved],coverage}).success).toBe(true);
    expect(manualProspectPhoneEvidenceSchema.safeParse({state:'observed',value:source.normalizedValue,sources:[unresolved],coverage}).success).toBe(false);
    expect(manualLiteralPhoneSourceSchema.safeParse({...source,normalizationBasis:'unsupported'}).success).toBe(false);
  });
  it('bounds results and keeps unavailable scanning separate from absence',()=>{
    expect(manualProspectPhoneEvidenceSchema.safeParse({state:'not_extracted',reason:'bounded_scan_incomplete',coverage:{...coverage,state:'bounded'}}).success).toBe(true);
    expect(manualProspectPhoneEvidenceSchema.safeParse({state:'observed',value:source.normalizedValue,sources:Array(17).fill(source),coverage}).success).toBe(false);
    expect(manualLiteralPhoneSourceSchema.safeParse({...source,literal:'x'.repeat(201),start:0,end:201}).success).toBe(false);
  });
});
