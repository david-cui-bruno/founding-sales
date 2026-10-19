import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {AnthropicMessageResponse,AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import type {OfficeExtractionRequest} from '@fss/domain/research/officeAssessmentContract.ts';
import {OFFICE_SELECTION_VERSION} from '@fss/domain/research/officeAssessmentContract.ts';
import {schemaProblems} from '@fss/domain/test/support/structuredOutputsSchema.ts';
import {anthropicExtraction} from '../src/research/anthropicExtraction.ts';
const id=randomUUID();
const request:OfficeExtractionRequest={purpose:'office_evidence',selectionVersion:OFFICE_SELECTION_VERSION,candidate:{firmName:'Northwind',website:'https://northwind.example.test/',locality:'Providence',region:'RI'},observations:[{id,url:'https://northwind.example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-19T12:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'Northwind manages residential properties in Providence, RI.'}]}],modelName:'claude-haiku-4-5',maxOutputTokens:600};
function fake(value:unknown,stop_reason='end_turn',usage:AnthropicMessageResponse['usage']={input_tokens:100,output_tokens:80}){
 const counted:unknown[]=[],sent:unknown[]=[];
 const transport:AnthropicMessagesTransport={countTokens:async body=>{counted.push(body);return 100;},create:async body=>{sent.push(body);return {content:[{type:'text',text:JSON.stringify(value)}],stop_reason,usage};}};
 return {port:anthropicExtraction({transport}),counted,sent};
}
describe('strict-only extraction on the existing reserved port',()=>{
 it('counts and sends the exact standalone selector request under unchanged 600 ceiling',async()=>{
  const f=fake({selections:[{kind:'firm_identity',observationId:id,blockId:'b1'}]});
  expect(await f.port.countInputTokens(request)).toBe(100);
  expect(await f.port.extract(request)).toMatchObject({ok:true,value:{purpose:'office_evidence',selections:[{kind:'firm_identity',observationId:id,blockId:'b1'}]}});
  expect(f.counted).toEqual(f.sent);expect(f.sent).toHaveLength(1);
  const wire=f.sent[0] as {max_tokens:number;output_config:{format:{schema:unknown}};messages:unknown};
  expect(wire.max_tokens).toBe(600);expect(schemaProblems(wire.output_config.format.schema)).toEqual([]);
  expect(JSON.stringify(wire.output_config)).not.toMatch(/opening|questions|quote/u);
  expect(JSON.stringify(wire.messages)).not.toMatch(/routeId|endpointHash|phoneRoute|targetPhone/u);
 });
 it.each(['max_tokens','pause_turn','refusal'])('fails closed on %s without a second call',async stop=>{
  const f=fake({selections:[]},stop);expect((await f.port.extract(request)).ok).toBe(false);expect(f.sent).toHaveLength(1);
 });
 it.each([{selections:[],openingQuestion:null},{selections:[{kind:'firm_identity',observationId:id,blockId:'missing',value:'invented'}]},{selections:[{kind:'unknown',observationId:id,blockId:'b1'}]}])('rejects incompatible selector shape %#',async value=>{expect((await fake(value).port.extract(request)).ok).toBe(false);});
 it('preserves unknown-cost accounting on a valid strict response',async()=>{const f=fake({selections:[]},'end_turn',{});const out=await f.port.extract(request);expect(out).toMatchObject({ok:true,costEstimated:true});});
});
