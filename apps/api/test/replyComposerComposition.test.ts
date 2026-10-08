import {expect,it,vi} from 'vitest';
import {loadHumanReplyDraftPort} from '../src/integrations/replyComposer.ts';
it('leaves generation unavailable without an explicit existing Bedrock deployment configuration',async()=>{
 const load=vi.fn(async()=>({kind:'bedrock' as const,countTokens:async()=>0,create:async()=>({})}));
 expect(await loadHumanReplyDraftPort({},load)).toBeNull();
 expect(await loadHumanReplyDraftPort({FSS_MODEL_TRANSPORT:'anthropic',AWS_REGION:'us-east-1'},load)).toBeNull();
 expect(await loadHumanReplyDraftPort({FSS_MODEL_TRANSPORT:'bedrock'},load)).toBeNull();
 expect(load).not.toHaveBeenCalled();
});
it('composes the approved credit-funded adapter without calling a model or falling back to another provider',async()=>{
 const create=vi.fn(async()=>({})),countTokens=vi.fn(async()=>0);
 const load=vi.fn(async()=>({kind:'bedrock' as const,countTokens,create}));
 const port=await loadHumanReplyDraftPort({FSS_MODEL_TRANSPORT:'bedrock',AWS_REGION:'us-east-1'},load);
 expect(port?.providerKey).toBe('aws_bedrock.outreach_reply');expect(load).toHaveBeenCalledOnce();
 expect(create).not.toHaveBeenCalled();expect(countTokens).not.toHaveBeenCalled();
});
