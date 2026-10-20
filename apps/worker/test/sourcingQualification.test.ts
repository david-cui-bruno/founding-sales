import {expect,it} from 'vitest';
import {qualificationExtraction} from '../src/sourcing/qualificationExtraction.ts';
import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
const source={id:'11111111-1111-4111-8111-111111111111',url:'https://example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-05T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'We need maintenance coordination help.'}]};
const input={candidate:{firmName:'Harbor Example Management',locality:'Boston',region:'MA' as const,website:'https://example.test/'},observations:[source],modelName:'claude-haiku-4-5',maxInputTokens:5000,maxOutputTokens:2048};
it('counts exactly the dispatched request and resolves references locally, never model quotations',async()=>{
 let counted:ClassifierRequest|undefined,sent:ClassifierRequest|undefined;
 const provider=qualificationExtraction({kind:'bedrock',countTokens:async r=>{counted=r;return 120;},create:async r=>{sent=r;return {usage:{input_tokens:120,output_tokens:60},content:[{type:'text',text:JSON.stringify({selections:[{kind:'help_request',observationId:source.id,blockId:'b1'}],openingQuestion:null})}]};}});
 expect(await provider.countInputTokens(input)).toBe(120);
 const answer=await provider.extract(input);
 expect(sent).toEqual(counted);expect(sent?.max_tokens).toBe(2048);
 expect(answer).toMatchObject({ok:true,value:{facts:[{kind:'help_request',value:source.blocks[0]!.text,observationId:source.id,blockId:'b1'}]}});
 expect(sent?.system[0]?.text).toContain('untrusted');
 expect(JSON.parse(String(sent?.messages[0]?.content)).candidate).toEqual(input.candidate);
});
it('charges a contradictory or nameless identity refusal without silently dropping the selected evidence',async()=>{
 for(const text of ['We provide excellent services.','Different Actual Management LLC']){
  const observation={...source,blocks:[{id:'b1',text}]},before=JSON.stringify(observation);
  const provider=qualificationExtraction({kind:'bedrock',countTokens:async()=>100,create:async()=>({usage:{input_tokens:100,output_tokens:50},content:[{type:'text',text:JSON.stringify({selections:[{kind:'firm_identity',observationId:source.id,blockId:'b1'}],openingQuestion:null})}]})});
  expect(await provider.extract({...input,observations:[observation]})).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:1});
  expect(JSON.stringify(observation)).toBe(before);
 }
});
it('supplements omitted literal roles from original supplied blocks but does not invent phone facts',async()=>{
 const observation={...source,blocks:[{id:'b1',text:input.candidate.firmName},{id:'b2',text:'Harbor Example Management manages residential homes in Boston, MA.'}]};
 const provider=qualificationExtraction({kind:'bedrock',countTokens:async()=>100,create:async()=>({usage:{input_tokens:100,output_tokens:50},content:[{type:'text',text:JSON.stringify({selections:[{kind:'residential_management',observationId:source.id,blockId:'b2'}],openingQuestion:null})}]})});
 const result=await provider.extract({...input,observations:[observation]});
 expect(result).toMatchObject({ok:true,value:{facts:[{kind:'residential_management',blockId:'b2'},{kind:'firm_identity',blockId:'b1'},{kind:'service_area',blockId:'b2'}]}});
 if(result.ok)expect(result.value.facts.some(f=>f.kind==='business_phone')).toBe(false);
});
it('rejects unknown references and invented fields after charging the model usage',async()=>{
 for(const selection of [{kind:'help_request',observationId:source.id,blockId:'missing'}, {kind:'help_request',observationId:source.id,blockId:'b1',value:'invented'}]){
  const p=qualificationExtraction({kind:'bedrock',countTokens:async()=>100,create:async()=>({usage:{input_tokens:100,output_tokens:50},content:[{type:'text',text:JSON.stringify({selections:[selection],openingQuestion:null})}]})});
  expect(await p.extract(input)).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:1});
 }
});
it('refuses a direct API route without calling it and estimates ambiguous failures',async()=>{
 let calls=0;
 const transport:AnthropicMessagesTransport={kind:'anthropic',countTokens:async()=>{calls++;return 1;},create:async()=>{calls++;return {};}};
 expect(await qualificationExtraction(transport).extract(input)).toMatchObject({ok:false,failureCode:'credit_route_unavailable'});expect(calls).toBe(0);
 const failed=qualificationExtraction({...transport,kind:'bedrock',create:async()=>{throw new Error('timeout');}});
 expect(await failed.extract(input)).toMatchObject({ok:false,costEstimated:true});
});

it('registers qualification only with a page fetcher and keeps outbound-fence transaction ownership',async()=>{
 const {HandlerRegistry}=await import('@fss/domain/jobs/handlerRegistry.ts');
 const {registerHandlers}=await import('../src/bootstrap/main.ts');
 const empty={classifier:undefined,mail:undefined,send:undefined,research:undefined};
 expect(registerHandlers(new HandlerRegistry(),empty).get('sourcing.qualify')).toBeUndefined();
 const registered=registerHandlers(new HandlerRegistry(),{...empty,research:{pageFetch:{providerKey:'test',fetchPages:async()=>({ok:false,costCents:0,failureCode:'unavailable'})}}}).get('sourcing.qualify');
 expect(registered).toMatchObject({protection:'outbound_fence',maxAttempts:1});
});

const selected={kind:'help_request',observationId:source.id,blockId:'b1'};
async function extractText(text:string,stop_reason?:string,observations=input.observations){
 const provider=qualificationExtraction({kind:'bedrock',countTokens:async()=>100,create:async()=>({usage:{input_tokens:100,output_tokens:50},...(stop_reason===undefined?{}:{stop_reason}),content:[{type:'text',text}]})});
 return provider.extract({...input,observations});
}
const encoded=(selections:unknown,extra:Record<string,unknown>={})=>JSON.stringify({selections,openingQuestion:null,...extra});
it.each([
 [encoded([{...selected,kind:'private invalid kind'}]),'schema_invalid_value','kind',0],
 [encoded([{...selected,observationId:'private invalid uuid'}]),'schema_invalid_format','observationId',0],
 [encoded([{...selected,blockId:5}]),'schema_invalid_type','blockId',0],
 [encoded([{...selected,privateField:'private source quote'}]),'schema_unrecognized_fields','selection',0],
 [encoded([],{privateField:'private provider payload'}),'schema_unrecognized_fields','root',undefined],
 [encoded([],{openingQuestion:'private'.repeat(50)}),'schema_over_bound','openingQuestion',undefined],
 [encoded(Array.from({length:31},()=>selected)),'schema_over_bound','selections',undefined],
])('maps schema rejection to a fixed field, never raw paths/messages: %s',async(text,code,schemaField,selectionIndex)=>{
 const result=await extractText(text,'end_turn');
 expect(result).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:1,diagnostic:{stage:'schema',code,schemaField,stopReason:'end_turn'}});
 if(!result.ok){expect(result.diagnostic?.selectionIndex).toBe(selectionIndex);expect(result.diagnostic).not.toHaveProperty('message');expect(JSON.stringify(result)).not.toContain('private');if(text.includes('private invalid kind'))expect(result.diagnostic?.selectionCount).toBe(1);}
});
it('does not clamp over-bound selection counts or retain unknown observation/block references',async()=>{
 const overflow=await extractText(encoded(Array.from({length:31},()=>selected)));
 expect(overflow.diagnostic).not.toHaveProperty('selectionCount');
 const missing=await extractText(encoded([{...selected,blockId:'private missing block'}]));
 expect(missing).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:1,diagnostic:{stage:'selection',code:'block_missing',selectionIndex:0,selectionCount:1,observationId:source.id}});
 expect(missing.diagnostic).not.toHaveProperty('blockId');
 const foreign=await extractText(encoded([{...selected,observationId:'22222222-2222-4222-8222-222222222222'}]));
 expect(foreign).toMatchObject({ok:false,diagnostic:{stage:'selection',code:'observation_unoffered'}});
 expect(foreign.diagnostic).not.toHaveProperty('observationId');expect(foreign.diagnostic).not.toHaveProperty('blockId');
 const long=await extractText(encoded([selected]),undefined,[{...source,blocks:[{id:'b1',text:'x'.repeat(2001)}]}]);
 expect(long).toMatchObject({ok:false,diagnostic:{code:'block_over_bound',observationId:source.id,blockId:'b1'}});
});
it.each(['end_turn','max_tokens','stop_sequence','tool_use','pause_turn','private raw stop reason'])('maps malformed JSON stop reason %s without changing public failure or cost',async stop=>{
 const result=await extractText('private malformed JSON',stop);
 expect(result).toEqual({ok:false,failureCode:'malformed_answer',costCents:1,diagnostic:{stage:'json',code:'json_invalid',stopReason:stop.startsWith('private')?'other':stop}});
});
it('keeps explicit refusal distinct and retains cost-estimation semantics on rejected output',async()=>{
 expect(await extractText('private refused content','refusal')).toEqual({ok:false,failureCode:'model_refusal',costCents:1});
 const provider=qualificationExtraction({kind:'bedrock',countTokens:async()=>100,create:async()=>({content:[{type:'text',text:encoded([{...selected,blockId:'missing'}])}]})});
 expect(await provider.extract(input)).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:0,costEstimated:true,diagnostic:{code:'block_missing'}});
});
it('retains literal role rejection subtypes but neither selected source text nor generated facts',async()=>{
 for(const [text,code] of [['Different Actual Management LLC','identity_not_literal'],[`Website by ${input.candidate.firmName}`,'identity_forbidden']]){
  const result=await extractText(encoded([{...selected,kind:'firm_identity'}]),'max_tokens',[{...source,blocks:[{id:'b1',text:text!}]}]);
  expect(result).toMatchObject({ok:false,failureCode:'invalid_evidence',diagnostic:{stage:'citation_roles',code,observationId:source.id,blockId:'b1',stopReason:'max_tokens'}});
  expect(JSON.stringify(result)).not.toContain(text!);expect(result).not.toHaveProperty('value');
 }
 const observation={...source,blocks:[{id:'b1',text:input.candidate.firmName},{id:'b2',text:'Harbor Example Management manages residential homes in Boston, MA.'}]};
 const result=await extractText(encoded(Array.from({length:30},()=>({...selected,kind:'residential_management',blockId:'b2'}))),undefined,[observation]);
 expect(result).toMatchObject({ok:false,failureCode:'invalid_evidence',diagnostic:{stage:'citation_roles',code:'supplement_over_bound',selectionCount:30}});
});
