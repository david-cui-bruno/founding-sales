import {expect,it} from 'vitest';
import {socialGuidedRequestInputSchema,socialGuidedRequestReceiptInputSchema,socialGuidedRequestReceiptSchema} from '../src/index.ts';
const id='00000000-0000-4000-8000-000000000001';
const input={mode:'linkedin_grounded',sourceRefs:[],factBlocks:[{id,version:1}],voiceGuideRef:{guideId:id,revision:1}};
it('admits only explicit grounded guide and approved factual references',()=>{
 expect(socialGuidedRequestInputSchema.parse(input)).toEqual(input);
 for(const invalid of [
  {...input,mode:undefined},{...input,voiceGuideRef:undefined},{...input,factBlocks:[]},
  {...input,sourceRefs:[{kind:'call',id,revision:1}]},
  {...input,sourceRefs:[{kind:'meeting',id,revision:1}]},
  {...input,voiceGuideRef:{guideId:id,revision:0}},
  {...input,voiceGuideRef:{guideId:id,revision:1,entries:['private guidance']}},
  {...input,factBlocks:[{id,version:1,text:'invented fact'}]},
  {...input,provider:'real'}, {...input,publish:true}, {...input,clientVersion:'1.0.0'},
 ])expect(socialGuidedRequestInputSchema.safeParse(invalid).success).toBe(false);
});
it('keeps receipt identity exact and output opaque',()=>{
 const receipt={commandId:id,payloadSHA256:'a'.repeat(64)};
 expect(socialGuidedRequestReceiptInputSchema.parse(receipt)).toEqual(receipt);
 expect(socialGuidedRequestReceiptInputSchema.safeParse({...receipt,payloadSHA256:'bad'}).success).toBe(false);
 expect(socialGuidedRequestReceiptInputSchema.safeParse({...receipt,body:input}).success).toBe(false);
 for(const valid of [{state:'unknown'},{state:'refused',reason:'source_changed_or_unavailable'},{state:'accepted',result:{requestId:id}}])expect(socialGuidedRequestReceiptSchema.safeParse(valid).success).toBe(true);
 expect(socialGuidedRequestReceiptSchema.safeParse({state:'accepted',result:{requestId:id,concepts:['prose']}}).success).toBe(false);
});
