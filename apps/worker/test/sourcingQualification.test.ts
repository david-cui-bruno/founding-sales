import {expect,it} from 'vitest';
import {qualificationExtraction} from '../src/sourcing/qualificationExtraction.ts';
import {VertexRequestError,type GeminiResponse,type GeminiSurface} from '../src/sourcing/vertexGemini.ts';
import {QUALIFICATION_MODEL_NAME,QUALIFICATION_PROVIDER_KEY} from '@fss/domain/sourcing/qualificationModel.ts';
import {QUALIFICATION_OUTPUT_TOKENS,QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE,QUALIFICATION_SYSTEM_TEXT,QUALIFICATION_THINKING_BUDGET_TOKENS,type QualificationGeminiRequest} from '@fss/domain/sourcing/qualificationPrompt.ts';
const source={id:'11111111-1111-4111-8111-111111111111',url:'https://example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-05T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'We need maintenance coordination help.'}]};
const input={candidate:{firmName:'Harbor Example Management',locality:'Boston',region:'MA' as const,website:'https://example.test/'},observations:[source],modelName:QUALIFICATION_MODEL_NAME,maxInputTokens:5000,maxOutputTokens:QUALIFICATION_OUTPUT_TOKENS};
const usage={promptTokenCount:100,candidatesTokenCount:50,totalTokenCount:150};
/** A Vertex generateContent answer: one candidate whose text is `text`. */
const answer=(text:string,extra:Partial<GeminiResponse>&{finishReason?:string}={}):GeminiResponse=>{
 const {finishReason='STOP',...rest}=extra;
 return {candidates:[{content:{parts:[{text}]},finishReason}],usageMetadata:usage,...rest};
};
const surfaceOf=(response:GeminiResponse|(()=>never),count=100):GeminiSurface=>({countTokens:async()=>count,generate:async()=>{if(typeof response==='function')return response();return response;}});
const selectionsOf=(selections:unknown)=>JSON.stringify({selections,openingQuestion:null});
it('counts the dispatched prompt plus the response schema Vertex does not count, and resolves references locally, never model quotations',async()=>{
 let counted:Parameters<GeminiSurface['countTokens']>[0]|undefined,sent:QualificationGeminiRequest|undefined;
 const provider=qualificationExtraction({countTokens:async r=>{counted=r;return 120;},generate:async r=>{sent=r;return answer(selectionsOf([{kind:'help_request',observationId:source.id,blockId:'b1'}]));}});
 expect(provider.providerKey).toBe(QUALIFICATION_PROVIDER_KEY);
 expect(await provider.countInputTokens(input)).toBe(120+QUALIFICATION_SCHEMA_TOKEN_ALLOWANCE);
 const result=await provider.extract(input);
 expect(sent).toMatchObject({systemInstruction:counted?.systemInstruction,contents:counted?.contents});
 expect(sent?.systemInstruction.parts[0].text).toBe(QUALIFICATION_SYSTEM_TEXT);
 expect(sent?.generationConfig).toMatchObject({temperature:0,maxOutputTokens:QUALIFICATION_OUTPUT_TOKENS,responseMimeType:'application/json',thinkingConfig:{thinkingBudget:QUALIFICATION_THINKING_BUDGET_TOKENS}});
 expect(sent?.generationConfig.responseSchema).toMatchObject({type:'OBJECT',required:['selections','openingQuestion'],properties:{selections:{type:'ARRAY',items:{required:['kind','observationId','blockId']}},openingQuestion:{type:'STRING',nullable:true}}});
 expect(sent?.generationConfig.responseSchema.properties.selections.items.properties.kind.enum).toContain('residential_management');
 expect(result).toMatchObject({ok:true,value:{facts:[{kind:'help_request',value:source.blocks[0]!.text,observationId:source.id,blockId:'b1'}]}});
 expect(sent?.systemInstruction.parts[0].text).toContain('untrusted');
 expect(JSON.parse(sent?.contents[0].parts[0].text??'{}').candidate).toEqual(input.candidate);
});
it('bounds the output ceiling by the reservation and keeps the thinking budget inside it',async()=>{
 let sent:QualificationGeminiRequest|undefined;
 const provider=qualificationExtraction({countTokens:async()=>1,generate:async r=>{sent=r;return answer(selectionsOf([]));}});
 await provider.extract({...input,maxOutputTokens:3000});
 expect(sent?.generationConfig.maxOutputTokens).toBe(3000);
 expect(QUALIFICATION_THINKING_BUDGET_TOKENS).toBeLessThan(QUALIFICATION_OUTPUT_TOKENS);
});
it('charges a contradictory or nameless identity refusal without silently dropping the selected evidence',async()=>{
 for(const text of ['We provide excellent services.','Different Actual Management LLC']){
  const observation={...source,blocks:[{id:'b1',text}]},before=JSON.stringify(observation);
  const provider=qualificationExtraction(surfaceOf(answer(selectionsOf([{kind:'firm_identity',observationId:source.id,blockId:'b1'}]))));
  expect(await provider.extract({...input,observations:[observation]})).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:1});
  expect(JSON.stringify(observation)).toBe(before);
 }
});
it('supplements omitted literal roles from original supplied blocks but does not invent phone facts',async()=>{
 const observation={...source,blocks:[{id:'b1',text:input.candidate.firmName},{id:'b2',text:'Harbor Example Management manages residential homes in Boston, MA.'}]};
 const provider=qualificationExtraction(surfaceOf(answer(selectionsOf([{kind:'residential_management',observationId:source.id,blockId:'b2'}]))));
 const result=await provider.extract({...input,observations:[observation]});
 expect(result).toMatchObject({ok:true,value:{facts:[{kind:'residential_management',blockId:'b2'},{kind:'firm_identity',blockId:'b1'},{kind:'service_area',blockId:'b2'}]}});
 if(result.ok)expect(result.value.facts.some(f=>f.kind==='business_phone')).toBe(false);
});
it('rejects unknown references and invented fields after charging the model usage',async()=>{
 for(const selection of [{kind:'help_request',observationId:source.id,blockId:'missing'}, {kind:'help_request',observationId:source.id,blockId:'b1',value:'invented'}]){
  const p=qualificationExtraction(surfaceOf(answer(selectionsOf([selection]))));
  expect(await p.extract(input)).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:1});
 }
});
it('refuses another model without calling Vertex, settles a definite HTTP refusal at zero and estimates ambiguous failures',async()=>{
 let calls=0;
 const counting:GeminiSurface={countTokens:async()=>{calls++;return 1;},generate:async()=>{calls++;return answer(selectionsOf([]));}};
 const other={...input,modelName:'claude-haiku-4-5'};
 expect(await qualificationExtraction(counting).extract(other)).toMatchObject({ok:false,failureCode:'credit_route_unavailable'});
 await expect(qualificationExtraction(counting).countInputTokens(other)).rejects.toThrow('credit_route_unavailable');
 expect(calls).toBe(0);
 // 4xx (not 408): refused before generation, billed nothing, not estimated.
 expect(await qualificationExtraction(surfaceOf(()=>{throw new VertexRequestError(429);})).extract(input)).toEqual({ok:false,failureCode:'provider_refused',costCents:0});
 // No token could be obtained: nothing left this process.
 expect(await qualificationExtraction(surfaceOf(()=>{throw new VertexRequestError(null,true);})).extract(input)).toEqual({ok:false,failureCode:'provider_refused',costCents:0});
 for(const status of [null,408,500,503]){
  expect(await qualificationExtraction(surfaceOf(()=>{throw new VertexRequestError(status);})).extract(input)).toEqual({ok:false,failureCode:'provider_error',costCents:0,costEstimated:true});
 }
 expect(await qualificationExtraction(surfaceOf(()=>{throw new Error('timeout');})).extract(input)).toMatchObject({ok:false,costEstimated:true});
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
async function extractText(text:string,finishReason?:string,observations=input.observations){
 const provider=qualificationExtraction(surfaceOf(answer(text,finishReason===undefined?{}:{finishReason})));
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
 const result=await extractText(text,'STOP');
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
it.each([['STOP','end_turn'],['MAX_TOKENS','max_tokens'],['OTHER','other'],['private raw finish reason','other']])('maps malformed JSON finish reason %s without changing public failure or cost',async(finish,stop)=>{
 const result=await extractText('private malformed JSON',finish);
 expect(result).toEqual({ok:false,failureCode:'malformed_answer',costCents:1,diagnostic:{stage:'json',code:'json_invalid',stopReason:stop}});
});
it('keeps an explicit refusal or block distinct and retains cost-estimation semantics on rejected output',async()=>{
 for(const finish of ['SAFETY','PROHIBITED_CONTENT','BLOCKLIST'])expect(await extractText('private refused content',finish)).toEqual({ok:false,failureCode:'model_refusal',costCents:1});
 expect(await qualificationExtraction(surfaceOf({promptFeedback:{blockReason:'SAFETY'},usageMetadata:{promptTokenCount:100,totalTokenCount:100}})).extract(input)).toEqual({ok:false,failureCode:'model_refusal',costCents:1});
 const provider=qualificationExtraction(surfaceOf({candidates:[{content:{parts:[{text:encoded([{...selected,blockId:'missing'}])}]},finishReason:'STOP'}]}));
 expect(await provider.extract(input)).toMatchObject({ok:false,failureCode:'invalid_evidence',costCents:0,costEstimated:true,diagnostic:{code:'block_missing'}});
});
it('retains literal role rejection subtypes but neither selected source text nor generated facts',async()=>{
 for(const [text,code] of [['Different Actual Management LLC','identity_not_literal'],[`Website by ${input.candidate.firmName}`,'identity_forbidden']]){
  const result=await extractText(encoded([{...selected,kind:'firm_identity'}]),'MAX_TOKENS',[{...source,blocks:[{id:'b1',text:text!}]}]);
  expect(result).toMatchObject({ok:false,failureCode:'invalid_evidence',diagnostic:{stage:'citation_roles',code,observationId:source.id,blockId:'b1',stopReason:'max_tokens'}});
  expect(JSON.stringify(result)).not.toContain(text!);expect(result).not.toHaveProperty('value');
 }
 const observation={...source,blocks:[{id:'b1',text:input.candidate.firmName},{id:'b2',text:'Harbor Example Management manages residential homes in Boston, MA.'}]};
 const result=await extractText(encoded(Array.from({length:30},()=>({...selected,kind:'residential_management',blockId:'b2'}))),undefined,[observation]);
 expect(result).toMatchObject({ok:false,failureCode:'invalid_evidence',diagnostic:{stage:'citation_roles',code:'supplement_over_bound',selectionCount:30}});
});

it('retains a unique scoped area despite a weak selected city label on the current extraction path',async()=>{
 const observation={...source,blocks:[{id:'name',text:input.candidate.firmName},{id:'label',text:'Boston, Massachusetts Welcome Home'},{id:'description',text:'Harbor Example Management manages residential homes in Boston, Massachusetts.'}]};
 const provider=qualificationExtraction(surfaceOf(answer(selectionsOf([{kind:'firm_identity',observationId:source.id,blockId:'name'},{kind:'service_area',observationId:source.id,blockId:'label'},{kind:'residential_management',observationId:source.id,blockId:'description'}]))));
 const result=await provider.extract({...input,observations:[observation]});
 expect(result).toMatchObject({ok:true,value:{facts:[{kind:'firm_identity',blockId:'name'},{kind:'service_area',blockId:'label'},{kind:'residential_management',blockId:'description'},{kind:'service_area',blockId:'description'}]}});
});
it('bills reasoning tokens as output, whether reported separately or only in the total',async()=>{
 const ok=selectionsOf([]);
 // 1M prompt + 100k candidates + 900k thoughts: (1M*75 + 1M*375)/1M = 450 cents through 2026.
 const separate=await qualificationExtraction(surfaceOf(answer(ok,{usageMetadata:{promptTokenCount:1_000_000,candidatesTokenCount:100_000,thoughtsTokenCount:900_000,totalTokenCount:2_000_000}}))).extract(input);
 // Thoughts folded into candidates: total is authoritative.
 const folded=await qualificationExtraction(surfaceOf(answer(ok,{usageMetadata:{promptTokenCount:1_000_000,candidatesTokenCount:100_000,totalTokenCount:2_000_000}}))).extract(input);
 expect(separate).toMatchObject({ok:true,costCents:450});
 expect(folded).toMatchObject({ok:true,costCents:450});
 expect(separate).not.toHaveProperty('costEstimated');
});
it('estimates the cost when the answer reports no usable usage',async()=>{
 for(const usageMetadata of [undefined,{},{promptTokenCount:100},{promptTokenCount:-1,candidatesTokenCount:5},{promptTokenCount:100,candidatesTokenCount:'5' as unknown as number}]){
  const response=answer(selectionsOf([]));
  const {usageMetadata:_ignored,...rest}=response;
  expect(await qualificationExtraction(surfaceOf(usageMetadata===undefined?rest:{...rest,usageMetadata})).extract(input)).toMatchObject({ok:true,costCents:0,costEstimated:true});
 }
});
it('ignores thought parts and reads the answer from the text parts',async()=>{
 const provider=qualificationExtraction(surfaceOf({candidates:[{content:{parts:[{text:'private reasoning',thought:true},{text:selectionsOf([{kind:'help_request',observationId:source.id,blockId:'b1'}])}]},finishReason:'STOP'}],usageMetadata:usage}));
 expect(await provider.extract(input)).toMatchObject({ok:true,value:{facts:[{kind:'help_request'}]}});
});
