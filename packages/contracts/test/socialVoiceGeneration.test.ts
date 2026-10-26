import {describe,expect,it} from 'vitest';
import {socialDraftRequestSchema,socialDraftRequestCommandSchema,socialDraftViewSchema} from '../src/social.ts';

const guideId='10000000-0000-4000-8000-000000000001';
const selection={mode:'linkedin_grounded' as const,sourceRefs:[],factBlocks:[],voiceGuideRef:{guideId,revision:2}};
describe('explicit owner-curated Social guide selection',()=>{
 it('accepts an exact opaque guide identity on grounded requests',()=>{
  expect(socialDraftRequestSchema.parse(selection)).toEqual(selection);
 });
 it('retains the guide reference in the ordinary command envelope',()=>{
  const command={...selection,commandId:'10000000-0000-4000-8000-000000000002',clientVersion:'1.4.7'};
  expect(socialDraftRequestCommandSchema.parse(command)).toEqual(command);
 });
 it('preserves requests with no guide rather than opting them in',()=>{
  expect(socialDraftRequestSchema.parse({sourceRefs:[],factBlocks:[]})).toEqual({sourceRefs:[],factBlocks:[]});
 });
 it('refuses a guide on the legacy non-grounded mode',()=>{
  expect(socialDraftRequestSchema.safeParse({sourceRefs:[],factBlocks:[],voiceGuideRef:selection.voiceGuideRef}).success).toBe(false);
 });
 it.each([0,-1,1.5])('refuses nonpositive or noninteger guide revision %s',revision=>{
  expect(socialDraftRequestSchema.safeParse({...selection,voiceGuideRef:{guideId,revision}}).success).toBe(false);
 });
 it('refuses inline guidance, owner overrides and unknown nested fields',()=>{
  for(const extra of [{guidance:'private instruction'},{ownerUserId:guideId},{entries:[]}]){
   expect(socialDraftRequestSchema.safeParse({...selection,voiceGuideRef:{...selection.voiceGuideRef,...extra}}).success).toBe(false);
  }
  expect(socialDraftRequestSchema.safeParse({...selection,guidance:'private instruction'}).success).toBe(false);
 });
 it('projects opaque guide identity without exposing guide text',()=>{
  const view={id:guideId,mode:'linkedin_grounded',state:'queued',sourceRefs:[],factBlocks:[],voiceGuideRef:selection.voiceGuideRef,concepts:null,reason:null,createdAt:'2026-10-26T13:00:00.000Z',deadlineAt:'2026-10-27T13:00:00.000Z'};
  expect(socialDraftViewSchema.parse(view)).toEqual(view);
  expect(socialDraftViewSchema.safeParse({...view,voiceGuideRef:{...selection.voiceGuideRef,guidance:'not projected'}}).success).toBe(false);
 });
});
