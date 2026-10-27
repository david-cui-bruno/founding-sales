import {describe,expect,it} from 'vitest';
import {sourceObservationSchema} from '../src/sourcingQualification.ts';
import {prospectPhoneObservationSchema} from '../src/prospectPhoneObservation.ts';
import {manualLiteralPhoneDiagnosticSchema,manualLiteralPhoneSourceSchema} from '../src/manualLiteralPhone.ts';
const id='00000000-0000-4000-8000-000000000001';
const at='2026-10-27T00:00:00.000Z';
const source={id,url:'https://fixture.invalid/contact',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:at,
 publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'x'.repeat(4001)}]};
const authority={kind:'phone_discovery',runId:id,expiresAt:'2026-10-28T00:00:00.000Z'} as const;
const diagnostic={reason:'unattached_label_content',runId:id,observationId:id,blockId:'b1',url:source.url,retrievedAt:at,
 contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,parser:'manual-literal-phone-v1',
 label:'Phone',labelStart:4500,labelEnd:4505,authority,lineage:{kind:'provider_original'}} as const;
const literal={method:'retained_original_literal',runId:id,observationId:id,blockId:'b1',url:source.url,retrievedAt:at,
 contentHash:source.contentHash,relevantTextHash:source.relevantTextHash,parser:'manual-literal-phone-v1',
 literal:'202-555-0100',start:4507,end:4519,label:'Phone',labelStart:4500,labelEnd:4505,authority,lineage:{kind:'provider_original'},
 normalizedValue:'+12025550100',normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us'} as const;
describe('phone-only complete observation capacity',()=>{
 it('accepts whole long blocks without expanding qualification',()=>{
  expect(prospectPhoneObservationSchema.parse(source).blocks[0]?.text).toBe(source.blocks[0]?.text);
  expect(sourceObservationSchema.safeParse(source).success).toBe(false);
 });
 it('accepts 256 complete blocks but refuses 257 and preserves the old 100 limit',()=>{
  const blocks=Array.from({length:256},(_,i)=>({id:`b${i}`,text:'x'}));
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks}).success).toBe(true);
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks:[...blocks,{id:'extra',text:'x'}]}).success).toBe(false);
  expect(sourceObservationSchema.safeParse({...source,blocks:blocks.slice(0,101)}).success).toBe(false);
 });
 it('enforces whole-block and joined page character boundaries',()=>{
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks:[{id:'b1',text:'x'.repeat(16000)}]}).success).toBe(true);
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks:[{id:'b1',text:'x'.repeat(16001)}]}).success).toBe(false);
  const blocks=Array.from({length:4},(_,i)=>({id:`b${i}`,text:'x'.repeat(i===3?1994:16000)}));
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks}).success).toBe(true);
  blocks[3]!.text+='x';
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks}).success).toBe(false);
 });
 it('retains unique identity and complete first-party requirements',()=>{
  expect(prospectPhoneObservationSchema.safeParse({...source,blocks:[source.blocks[0],source.blocks[0]]}).success).toBe(false);
  expect(prospectPhoneObservationSchema.safeParse({...source,truncated:true}).success).toBe(false);
  expect(prospectPhoneObservationSchema.safeParse({...source,firstParty:false}).success).toBe(false);
  expect(prospectPhoneObservationSchema.safeParse({...source,publishedAt:at,publishedAtBlockId:'b1'}).success).toBe(false);
 });
 it('permits larger exact diagnostic spans only for discovery authority',()=>{
  expect(manualLiteralPhoneDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  expect(manualLiteralPhoneDiagnosticSchema.safeParse({...diagnostic,authority:{kind:'candidate_source',sourceUrl:source.url}}).success).toBe(false);
  expect(manualLiteralPhoneDiagnosticSchema.safeParse({...diagnostic,labelEnd:4506}).success).toBe(false);
 });
 it('permits larger exact literal spans only for discovery authority',()=>{
  expect(manualLiteralPhoneSourceSchema.safeParse(literal).success).toBe(true);
  expect(manualLiteralPhoneSourceSchema.safeParse({...literal,authority:{kind:'retained_evidence',evidenceId:id}}).success).toBe(false);
  expect(manualLiteralPhoneSourceSchema.safeParse({...literal,end:4520}).success).toBe(false);
 });
});
