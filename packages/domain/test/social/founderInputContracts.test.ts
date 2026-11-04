import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {socialFounderInputSaveSchema,socialCalibrationFinishSchema,socialFounderReceiptSchema,socialDraftRequestSchema,SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE} from '@fss/contracts';
import {buildSocialDraftRequest,validateSocialDrafts,type SocialDraftInput} from '../../social/draftPolicy.ts';
const note={operation:'create',bullets:'I debugged a college prototype. I think small feedback loops matter.',context:'An actual owner experience and opinion.',experienceDate:null,publicSafe:true};
it('bounded current private notes require explicit eligibility and total private composition ceiling',()=>{
 expect(socialFounderInputSaveSchema.safeParse(note).success).toBe(true);
 const {publicSafe:_scope,...missing}=note;expect(socialFounderInputSaveSchema.safeParse(missing).success).toBe(false);
 expect(socialFounderInputSaveSchema.safeParse({...note,bullets:'a'.repeat(9500),context:'c'.repeat(501)}).success).toBe(false);
 expect(socialFounderInputSaveSchema.safeParse({...note,experienceDate:'2026-02-30'}).success).toBe(false);
 expect(socialFounderInputSaveSchema.safeParse({...note,training:true}).success).toBe(false);
});
it('founder mode is scoped and reference-only, independently of guide or workspace facts',()=>{
 const request={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[{inputId:randomUUID(),revision:1}],founderFormat:'opinion',founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE};
 expect(socialDraftRequestSchema.safeParse(request).success).toBe(true);
 const {founderInputProcessingScope:_scope,...unscoped}=request;
 expect(socialDraftRequestSchema.safeParse(unscoped).success).toBe(false);
 expect(socialDraftRequestSchema.safeParse({...request,founderInputRefs:[]}).success).toBe(false);
});
it('personal opinions and supplied personal experience survive founder validation without fabricated shared factual blocks',()=>{
 const input:SocialDraftInput={mode:'linkedin_founder',themes:[],facts:[],founderFormat:'opinion',founderNotes:[{bullets:note.bullets,context:note.context,experienceDate:null}],founderInputProcessingScope:SOCIAL_FOUNDER_INPUT_PROCESSING_SCOPE};
 const built=buildSocialDraftRequest(input);expect(built?.messages[0]?.content).toContain(note.bullets);expect(built?.system).toContain('independent approvedFacts support');
 const output=JSON.stringify({concepts:[{theme:'founder',factRefs:[],variants:[{platform:'linkedin',text:'I debugged a college prototype.\n\nI think small feedback loops matter.'}]}]});expect(validateSocialDrafts(output,input)).toHaveLength(1);
 const {founderInputProcessingScope:_scope,...unscoped}=input;
 expect(buildSocialDraftRequest(unscoped)).toBeNull();
 expect(validateSocialDrafts(output.replace('"factRefs":[]',`"factRefs":[{"id":"${randomUUID()}","version":1}]`),input)).toBeNull();
});
it('exact three distinct revisions and resulting guide are required; receipt rejects copied private prose',()=>{
 const examples=Array.from({length:3},()=>({draftId:randomUUID(),revision:1}));
 expect(socialCalibrationFinishSchema.safeParse({examples,expectedGuide:null}).success).toBe(true);
 expect(socialCalibrationFinishSchema.safeParse({examples:[examples[0],examples[0],examples[2]],expectedGuide:null}).success).toBe(false);
 expect(socialFounderReceiptSchema.safeParse({state:'accepted',result:{inputId:randomUUID(),revision:1,bullets:note.bullets}}).success).toBe(false);
});
