import {it,expect,vi} from 'vitest';
import {socialDraftModel} from '../src/social/draftModel.ts';
it('uses only Bedrock, caps output and never dispatches oversized input',async()=>{
 const create=vi.fn(async()=>({stop_reason:'end_turn',content:[{type:'text',text:'{}'}],usage:{input_tokens:100,output_tokens:20}}));
 const countTokens=vi.fn(async()=>100);const input={themes:['after_hours' as const],facts:[]};
 await expect(socialDraftModel({kind:'anthropic',create,countTokens}).generate(input)).rejects.toThrow('credit_route_unavailable');expect(create).not.toHaveBeenCalled();
 const port=socialDraftModel({kind:'bedrock',create,countTokens});await port.generate(input);
 expect(create).toHaveBeenCalledWith(expect.objectContaining({model:'claude-haiku-4-5',max_tokens:4096}));
 const oversized={...input,facts:[{id:'id',version:1,kind:'product' as const,text:'x'.repeat(25*1024)}]};
 await expect(port.generate(oversized)).rejects.toThrow('input_over_budget');expect(create).toHaveBeenCalledTimes(1);
});
it('refuses truncated generations and marks unknown usage as estimated',async()=>{
 const port=socialDraftModel({kind:'bedrock',countTokens:async()=>1,create:async()=>({stop_reason:'max_tokens',content:[{type:'text',text:'{"concepts":[]}'}]})});
 expect(await port.generate({themes:['after_hours'],facts:[]})).toMatchObject({raw:'',costEstimated:true});
});
