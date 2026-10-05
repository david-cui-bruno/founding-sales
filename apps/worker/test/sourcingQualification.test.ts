import {expect,it} from 'vitest';
import {qualificationExtraction} from '../src/sourcing/qualificationExtraction.ts';
import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
const source={id:'11111111-1111-4111-8111-111111111111',url:'https://example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:'2026-10-05T00:00:00Z',publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'b1',text:'We need maintenance coordination help.'}]};
const input={observations:[source],modelName:'claude-haiku-4-5',maxInputTokens:5000,maxOutputTokens:2048};
it('counts exactly the dispatched request and resolves references locally, never model quotations',async()=>{
 let counted:ClassifierRequest|undefined,sent:ClassifierRequest|undefined;
 const provider=qualificationExtraction({kind:'bedrock',countTokens:async r=>{counted=r;return 120;},create:async r=>{sent=r;return {usage:{input_tokens:120,output_tokens:60},content:[{type:'text',text:JSON.stringify({selections:[{kind:'help_request',observationId:source.id,blockId:'b1'}],openingQuestion:null})}]};}});
 expect(await provider.countInputTokens(input)).toBe(120);
 const answer=await provider.extract(input);
 expect(sent).toEqual(counted);expect(sent?.max_tokens).toBe(2048);
 expect(answer).toMatchObject({ok:true,value:{facts:[{kind:'help_request',value:source.blocks[0]!.text,observationId:source.id,blockId:'b1'}]}});
 expect(sent?.system[0]?.text).toContain('untrusted');
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
