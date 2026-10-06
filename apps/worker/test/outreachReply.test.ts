import {it,expect} from 'vitest';
import {routineReplyInterpretation} from '../src/outreach/replyInterpretation.ts';
import type {AnthropicMessagesTransport} from '@fss/domain/classification/anthropicClient.ts';
const input={messageText:'Can I see a demo?',contextText:'',blocks:[],human:true,matched:true,autoSubmitted:null};
it('uses Bedrock only and passes the full request through counting and dispatch',async()=>{
 const requests:unknown[]=[];
 const transport:AnthropicMessagesTransport={kind:'bedrock',countTokens:async request=>{requests.push(request);return 123;},create:async request=>{requests.push(request);return {stop_reason:'end_turn',content:[{type:'text',text:'{"kind":"review","reason":"no approved link"}'}],usage:{input_tokens:123,output_tokens:20}};}};
 const port=routineReplyInterpretation(transport);
 expect(await port.countInputTokens(input)).toBe(123);
 expect(await port.interpret(input)).toMatchObject({costEstimated:false});
 expect(requests[1]).toEqual(requests[0]);expect(requests[0]).toMatchObject({model:'claude-haiku-4-5',max_tokens:1024});
 const cash=routineReplyInterpretation({...transport,kind:'anthropic'});
 await expect(cash.countInputTokens(input)).rejects.toThrow('credit_route_unavailable');
 await expect(cash.interpret(input)).rejects.toThrow('credit_route_unavailable');
 expect(requests).toHaveLength(2);
});
it('does not accept truncated output, and treats missing usage as ambiguous spend',async()=>{
 const port=routineReplyInterpretation({kind:'bedrock',countTokens:async()=>1,create:async()=>({stop_reason:'max_tokens',content:[{type:'text',text:'partial'}]})});
 expect(await port.interpret(input)).toEqual({raw:'',costCents:0,costEstimated:true});
});
