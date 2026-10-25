import {describe,expect,it} from 'vitest';
import {socialPrivateDraftSaveInputSchema,socialPrivateDraftSaveCommandSchema,
 socialPrivateDraftListSchema,socialPrivateDraftReadSchema,socialPrivateDraftReceiptSchema,
 socialPrivateDraftReceiptInputSchema,socialPrivateDraftSavedSchema} from '../src/socialPrivateDrafts.ts';
const id='513f8960-cc58-40ba-80ee-4ddae0d37da7';
const hash='a'.repeat(64);
const manual={operation:'create',kind:'post',text:'  Exact private bytes\n',origin:{kind:'manual'}};
const metadata={draftId:id,revision:1,kind:'post',originKind:'manual',availability:'available',
 createdAt:'2026-10-25T01:00:00.000Z',updatedAt:'2026-10-25T01:00:00.000Z',expiresAt:'2027-01-23T01:00:00.000Z'};
describe('durable private composition boundary',()=>{
 it('saves exact manual post/comment bytes without an account or transformation',()=>{
  for(const kind of ['post','comment'])expect(socialPrivateDraftSaveInputSchema.parse({...manual,kind}).text).toBe(manual.text);
 });
 it('requires nonblank bounded private text',()=>{
  for(const text of ['', ' \n', 'x'.repeat(10001)])expect(socialPrivateDraftSaveInputSchema.safeParse({...manual,text}).success).toBe(false);
 });
 it('rejects publishing, destination and client identity fields',()=>{
  for(const field of ['accountId','publishAt','approvalId','targetUrl','images','ownerUserId','workspaceId']){
   expect(socialPrivateDraftSaveInputSchema.safeParse({...manual,[field]:id}).success).toBe(false);
  }
 });
 it('binds an initial sourced save to the exact selected request',()=>{
  const origin={kind:'suggestion',requestId:id,conceptIndex:0,variantIndex:2,selectionSHA256:hash};
  expect(socialPrivateDraftSaveInputSchema.safeParse({...manual,origin}).success).toBe(true);
  expect(socialPrivateDraftSaveInputSchema.safeParse({...manual,origin:{...origin,selectionSHA256:'wrong'}}).success).toBe(false);
  expect(socialPrivateDraftSaveInputSchema.safeParse({...manual,origin:{...origin,conceptIndex:3}}).success).toBe(false);
 });
 it('requires update revision and never permits lineage replacement',()=>{
  const update={operation:'update',draftId:id,expectedRevision:1,kind:'comment',text:'Edited'};
  expect(socialPrivateDraftSaveInputSchema.safeParse(update).success).toBe(true);
  for(const expectedRevision of [undefined,0,-1])expect(socialPrivateDraftSaveInputSchema.safeParse({...update,expectedRevision}).success).toBe(false);
  expect(socialPrivateDraftSaveInputSchema.safeParse({...update,origin:{kind:'manual'}}).success).toBe(false);
 });
 it('uses ordinary command identity without granting another action',()=>{
  const command={...manual,commandId:id,clientVersion:'1.0.0'};
  expect(socialPrivateDraftSaveCommandSchema.safeParse(command).success).toBe(true);
  expect(socialPrivateDraftSaveCommandSchema.safeParse({...command,operation:'approve'}).success).toBe(false);
 });
 it('lists bounded metadata without excerpts or composition bytes',()=>{
  const item={...metadata,text:'not metadata'};
  expect(socialPrivateDraftListSchema.safeParse({drafts:[metadata],nextAfterId:null}).success).toBe(true);
  expect(socialPrivateDraftListSchema.safeParse({drafts:[item],nextAfterId:null}).success).toBe(false);
  expect(socialPrivateDraftListSchema.safeParse({drafts:Array.from({length:21},()=>metadata),nextAfterId:id}).success).toBe(false);
 });
 it('requires human review for reopened text and forbids bytes on unavailable results',()=>{
  const draft={...metadata,text:'Private',origin:{kind:'manual'},reviewRequired:true};
  expect(socialPrivateDraftReadSchema.safeParse({draft}).success).toBe(true);
  expect(socialPrivateDraftReadSchema.safeParse({draft:{...draft,reviewRequired:false}}).success).toBe(false);
  const unavailable={...metadata,availability:'unavailable',reason:'expired'};
  expect(socialPrivateDraftReadSchema.safeParse({draft:unavailable}).success).toBe(true);
  expect(socialPrivateDraftReadSchema.safeParse({draft:{...unavailable,text:'old bytes'}}).success).toBe(false);
 });
 it('keeps save/receipt results content-free and unknown truly unknown',()=>{
  const result={draftId:id,revision:1};
  expect(socialPrivateDraftSavedSchema.safeParse(result).success).toBe(true);
  expect(socialPrivateDraftSavedSchema.safeParse({...result,text:'Private'}).success).toBe(false);
  expect(socialPrivateDraftReceiptSchema.safeParse({state:'accepted',result}).success).toBe(true);
  expect(socialPrivateDraftReceiptSchema.safeParse({state:'refused',reason:'stale_revision'}).success).toBe(true);
  expect(socialPrivateDraftReceiptSchema.safeParse({state:'unknown'}).success).toBe(true);
  expect(socialPrivateDraftReceiptSchema.safeParse({state:'unknown',result}).success).toBe(false);
  expect(socialPrivateDraftReceiptInputSchema.safeParse({commandId:id,payloadSHA256:hash}).success).toBe(true);
 });
});
