import {describe,expect,it} from 'vitest';
import {prospectPhoneRefusalOriginalInputSchema as input,prospectPhoneRefusalOriginalSchema as output} from '../src/prospectPhoneRefusalOriginal.ts';
const candidateId='00000000-0000-4000-8000-000000000001';
const runId='00000000-0000-4000-8000-000000000002';
const observationId='00000000-0000-4000-8000-000000000003';
const selection={candidateId,expectedRevision:1,runId,observationId,blockId:'b20',labelStart:0,labelEnd:5,reason:'unattached_label_content'};
const location={reason:selection.reason,runId,observationId,blockId:'b20',url:'https://company.example.test/contact',retrievedAt:'2026-10-27T09:00:00.000Z',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',label:'PHONE',labelStart:0,labelEnd:5,authority:{kind:'phone_discovery',runId,expiresAt:'2026-11-03T09:00:00.000Z'},lineage:{kind:'provider_original'}};
const original={candidateId,candidateRevision:1,location,text:'PHONE [review this retained source]',purpose:'manual_refusal_review',channelAuthority:'not_granted'};
describe('selected refusal original contract',()=>{
 it('accepts exact IDs and bounded original without a capture command',()=>{
  expect(input.parse(selection)).toEqual(selection);
  expect(output.parse(original)).toEqual(original);
 });
 it.each([{url:'https://other.example.test/'},{commandId:runId},{text:'injected'},{workspaceId:candidateId}])('rejects extra caller authority %j',extra=>{
  expect(input.safeParse({...selection,...extra}).success).toBe(false);
 });
 it('refuses empty or reversed spans and overflow',()=>{
  expect(input.safeParse({...selection,labelEnd:0}).success).toBe(false);
  expect(input.safeParse({...selection,labelEnd:16001}).success).toBe(false);
  expect(output.safeParse({...original,text:'PHONE'+'x'.repeat(15996)}).success).toBe(false);
 });
 it('rejects foreign authority, legacy lineage and label substitution',()=>{
  expect(output.safeParse({...original,location:{...location,authority:{...location.authority,runId:candidateId}}}).success).toBe(false);
  expect(output.safeParse({...original,location:{...location,authority:{kind:'candidate_source',sourceUrl:location.url}}}).success).toBe(false);
  expect(output.safeParse({...original,location:{...location,lineage:{kind:'retained_interpretation',decisionId:candidateId,originalRunId:runId,originalRevision:1,resultRevision:1}}}).success).toBe(false);
  expect(output.safeParse({...original,text:'OTHER original'}).success).toBe(false);
 });
 it('does not permit endpoint promotion or undisclosed extra content',()=>{
  expect(output.safeParse({...original,channelAuthority:'granted'}).success).toBe(false);
  expect(output.safeParse({...original,normalizedValue:'+12145550123'}).success).toBe(false);
  expect(output.safeParse({...original,blocks:[]}).success).toBe(false);
 });
});
