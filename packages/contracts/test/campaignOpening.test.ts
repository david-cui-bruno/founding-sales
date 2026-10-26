import {describe,expect,it} from 'vitest';
import {campaignOpeningPolicySchema,campaignOpeningChoiceSchema,campaignOpeningBindingSchema} from '../src/campaignOpening.ts';
const id='b385612c-cac8-43a3-a72d-fc2dd7d8553d';
const hash='a'.repeat(64);
const policy={id,workspaceId:id,ownerUserId:id,campaignId:id,campaignRevision:1,
 sequenceVersionId:id,templateVersionId:id,templateContentHash:hash,revision:1,
 mode:'approved_variant_selection_v1',firstEmailOnly:true,
 variants:[{id:'location',text:'Your residential management work in {{firm_locality}} caught my attention.'}],
 approvedAt:'2026-10-26T11:00:00.000Z',expiresAt:'2026-10-27T11:00:00.000Z'};
describe('bounded approved opening source contract',()=>{
 it('binds an explicit policy independently of existing template approval',()=>{
  expect(campaignOpeningPolicySchema.parse(policy)).toEqual(policy);
  for(const delta of [{mode:'generated'},{firstEmailOnly:false},{campaignRevision:0},
   {templateContentHash:'invalid'},{expiresAt:policy.approvedAt},{approved:true}])
   expect(campaignOpeningPolicySchema.safeParse({...policy,...delta}).success).toBe(false);
 });
 it('accepts only bounded uniquely identified approved phrases and closed placeholders',()=>{
  for(const variants of [[],Array(9).fill(policy.variants[0]),[policy.variants[0],policy.variants[0]],
   [{id:'location',text:'{{private_note}}'}],[{id:'location',text:'<script>text</script>'}],
   [{id:'location',text:'one\ntwo'}],[{id:'location',text:'x'.repeat(401)}]])
   expect(campaignOpeningPolicySchema.safeParse({...policy,variants}).success).toBe(false);
 });
 it('allows a choice, never arbitrary prose or authority from a selector',()=>{
  const choice={variantId:'location',citationIds:['observation:block']};
  expect(campaignOpeningChoiceSchema.parse(choice)).toEqual(choice);
  for(const delta of [{body:'invented familiarity'},{approved:true},{citationIds:[]},
   {citationIds:['same','same']},{variantId:'invalid value'}])
   expect(campaignOpeningChoiceSchema.safeParse({...choice,...delta}).success).toBe(false);
 });
 it('conserves exact opaque execution/source identity without recipient prose',()=>{
  const binding={workspaceId:id,ownerUserId:id,campaignId:id,campaignRevision:1,policyId:id,
   sequenceVersionId:id,templateVersionId:id,templateContentHash:hash,enrollmentId:id,executionId:id,
   firmId:id,candidateId:id,candidateRevision:1,qualificationRunId:id,sourceFingerprint:hash,
   validUntil:policy.expiresAt};
  expect(campaignOpeningBindingSchema.parse(binding)).toEqual(binding);
  for(const delta of [{body:'private'},{toAddress:'person@example.test'},
   {candidateRevision:0},{sourceFingerprint:'changed'},{sendAllowed:true}])
   expect(campaignOpeningBindingSchema.safeParse({...binding,...delta}).success).toBe(false);
 });
});
