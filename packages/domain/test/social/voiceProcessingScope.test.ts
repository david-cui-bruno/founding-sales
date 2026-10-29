import {beforeEach,expect,it,vi} from 'vitest';
import {SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE,type AnswerBlock,type SocialDraftRequest} from '@fss/contracts';
import {readSocialDraftSourcesForWorker} from '../../social/draftSources.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';

const mocks=vi.hoisted(()=>({blocks:vi.fn(),guide:vi.fn(),query:vi.fn()}));
vi.mock('../../outreach/facts.ts',()=>({readApprovedAnswerBlocks:mocks.blocks}));
vi.mock('../../social/voiceGeneration.ts',()=>({readPrivateVoiceGuide:mocks.guide}));
const id='10000000-0000-4000-8000-000000000001',entryId='20000000-0000-4000-8000-000000000002';
const selection:SocialDraftRequest={mode:'linkedin_grounded',sourceRefs:[],factBlocks:[{id,version:1}],voiceGuideRef:{guideId:id,revision:1}};
const guide={guideId:id,revision:1,entries:[{entryId,dimension:'tone' as const,guidance:'Use precise conversational sentences.'}]};
const fact:AnswerBlock={id,version:1,kind:'product',text:'A private draft workspace is planned.',approvedAt:'2026-10-25T00:00:00Z',retiredAt:null,socialInput:{topic:'build',status:'planned',sanitized:true}};
const ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:mocks.query});
beforeEach(()=>{vi.clearAllMocks();mocks.blocks.mockResolvedValue({ok:true,value:[fact]});mocks.guide.mockResolvedValue({ok:true,value:guide});mocks.query.mockResolvedValue({rows:[{id}],rowCount:1});});
it('carries the disclosed scope into the real source input and fingerprint without upgrading an old selection',async()=>{
 const old=await readSocialDraftSourcesForWorker(ctx,id,selection),scoped=await readSocialDraftSourcesForWorker(ctx,id,{...selection,voiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE});
 expect(old.ok).toBe(true);expect(scoped.ok).toBe(true);if(!old.ok||!scoped.ok)throw Error('fixture source unavailable');
 expect(old.value.input).not.toHaveProperty('voiceGuideProcessingScope');expect(selection).not.toHaveProperty('voiceGuideProcessingScope');
 expect(scoped.value.input.voiceGuideProcessingScope).toBe(SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE);expect(scoped.value.hash).not.toBe(old.value.hash);
 expect(scoped.value.input.privateVoiceGuide).toEqual(guide);expect(scoped.value.input.facts).toEqual(old.value.input.facts);
});
it('a scoped request still refuses a changed guide and cannot replace it with another current guide',async()=>{
 mocks.guide.mockResolvedValue({ok:false,reason:'voice_guide_changed_or_unavailable'});
 expect(await readSocialDraftSourcesForWorker(ctx,id,{...selection,voiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE})).toEqual({ok:false,reason:'voice_guide_changed_or_unavailable'});expect(mocks.blocks).not.toHaveBeenCalled();
});
it('processing scope alone cannot cross source parsing without an exact guide or grounded mode',async()=>{
 for(const invalid of [{...selection,voiceGuideRef:undefined},{...selection,mode:undefined},{...selection,voiceGuideProcessingScope:'other_provider'}]){
  const raw={...invalid,voiceGuideProcessingScope:'voiceGuideProcessingScope' in invalid?invalid.voiceGuideProcessingScope:SOCIAL_VOICE_GUIDE_PROCESSING_SCOPE};
  // Exercise persisted untrusted JSON through its ordinary parser.
  const source={...selection};Object.assign(source,raw);
  expect(await readSocialDraftSourcesForWorker(ctx,id,source)).toEqual({ok:false,reason:'invalid_input'});
 }
 expect(mocks.blocks).not.toHaveBeenCalled();expect(mocks.guide).not.toHaveBeenCalled();
});
