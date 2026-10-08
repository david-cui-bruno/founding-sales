import {saveAnswerBlock,approveAnswerBlock,retireAnswerBlock} from '../../outreach/facts.ts';
import {enrollMeetingFollowThrough} from '../../meetings/followThroughEligibility.ts';
import {afterEach,expect,it} from 'vitest';
import {withTransaction} from '../../db/queryable.ts';
import {prepareMeetingRecap,readMeetingFollowThrough,editMeetingRecap} from '../../meetings/followThrough.ts';
import {runMeetingFollowThrough} from '../../meetings/followThroughJobs.ts';
import {meetingFollowThroughFixture,RECAP_AT} from './support/meetingFollowThroughFixture.ts';
let stop:()=>Promise<void>=async()=>{};afterEach(async()=>stop());
it('prepares a recap without granting follow-through until the exact plan is approved',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();const p=await f.ready();
 await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));
 await withTransaction(f.db.session,()=>runMeetingFollowThrough(f.context,{meetingId:p.meetingId,at:RECAP_AT}));
 expect(await readMeetingFollowThrough(f.context,{meetingId:p.meetingId})).toMatchObject({approvalRequired:true,plannedSteps:[],blockers:expect.arrayContaining(['approval_required'])});
});
it('approves exact current source, content and bounded sequence once',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();const p=await f.ready();
 const prepared=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));if(!prepared.ok)throw new Error(prepared.reason);
 const v=prepared.value;
 expect(await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'approve',expectedApprovalHash:v.approvalHash!},RECAP_AT))).toMatchObject({ok:true,value:{approvalRequired:false,approvedAt:RECAP_AT}});
});

it('retired shared claims revoke current approval visibly and refuse enrollment',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();
 const fact=await withTransaction(f.db.session,()=>saveAnswerBlock(f.context,{kind:'product',text:'Callie coordinates maintenance requests.'}));if(!fact.ok)throw new Error(fact.reason);
 await withTransaction(f.db.session,()=>approveAnswerBlock(f.context,fact.value));
 const p=await f.ready({body:'Thanks for our conversation.\n\n{meeting_recap}\n\nCallie coordinates maintenance requests.\n\nSam Example\nCallie'});
 const prepared=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));if(!prepared.ok)throw new Error(prepared.reason);const v=prepared.value;if(!v.currentDraft)throw new Error(JSON.stringify(v));
 await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'approve',expectedApprovalHash:v.approvalHash!},RECAP_AT));
 await withTransaction(f.db.session,()=>retireAnswerBlock(f.context,fact.value));
 const current=(await readMeetingFollowThrough(f.context,{meetingId:p.meetingId}))!;
 expect(current).toMatchObject({approvalRequired:true,status:'needs_review',blockers:expect.arrayContaining(['facts_block_retired'])});
 expect(await withTransaction(f.db.session,()=>enrollMeetingFollowThrough(f.context,{planId:v.planId!,expectedVersion:current.version,at:RECAP_AT}))).toMatchObject({ok:false,reason:'facts_block_retired'});
});
it('changing approved recap bytes removes authority until a separate exact approval',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();const p=await f.ready();
 const prepared=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));if(!prepared.ok)throw new Error(prepared.reason);let v=prepared.value;
 const approve=await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'approve',expectedApprovalHash:v.approvalHash!},RECAP_AT));if(!approve.ok)throw new Error(approve.reason);v=approve.value;
 const begin=await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'begin_edit'},RECAP_AT));if(!begin.ok)throw new Error(begin.reason);v=begin.value;
 const save=await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'save',subject:v.currentDraft!.subject,body:'I will provide a new custom service.\n\nSam Example\nCallie'},RECAP_AT));
 expect(save).toMatchObject({ok:true,value:{approvalRequired:true,approvedAt:null,blockers:expect.arrayContaining(['approval_required'])}});
});
it('changed fact versions refuse unchanged historical claims rather than blessing old template copy',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();
 const saved=await withTransaction(f.db.session,()=>saveAnswerBlock(f.context,{kind:'product',text:'Callie coordinates maintenance requests.'}));if(!saved.ok)throw new Error(saved.reason);await withTransaction(f.db.session,()=>approveAnswerBlock(f.context,saved.value));
 const p=await f.ready({body:'Thanks.\n\n{meeting_recap}\n\nCallie coordinates maintenance requests.\n\nSam Example\nCallie'});
 const prepared=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));if(!prepared.ok)throw new Error(prepared.reason);const v=prepared.value;
 await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'approve',expectedApprovalHash:v.approvalHash!},RECAP_AT));
 const changed=await withTransaction(f.db.session,()=>saveAnswerBlock(f.context,{id:saved.value.id,expectedVersion:1,kind:'product',text:'Callie helps review maintenance requests.'}));if(!changed.ok)throw new Error(changed.reason);await withTransaction(f.db.session,()=>approveAnswerBlock(f.context,changed.value));
 const current=(await readMeetingFollowThrough(f.context,{meetingId:p.meetingId}))!;
 expect(current.blockers).toContain('facts_block_changed');
 expect(await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:current.planId!,expectedPlanVersion:current.version,expectedDraftVersion:current.currentDraft!.version,action:'approve',expectedApprovalHash:current.approvalHash??v.approvalHash!},RECAP_AT))).toMatchObject({ok:false,reason:'facts_block_changed'});
});
it('retains old template authority for a legacy plan but gives changed legacy copy no new permission',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();const p=await f.ready();const result=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));if(!result.ok)throw new Error(result.reason);
 // Fixture represents a row predating schema69. Migration only labels existing authority; it creates no approval.
 await f.db.session.query("UPDATE meeting_follow_through SET approval_mode='legacy_template' WHERE id=$1",[result.value.planId]);
 let v=(await readMeetingFollowThrough(f.context,{meetingId:p.meetingId}))!;expect(v).toMatchObject({approvalRequired:false,approvedAt:null});
 const begin=await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'begin_edit'},RECAP_AT));if(!begin.ok)throw new Error(begin.reason);v=begin.value;
 expect(await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'save',subject:v.currentDraft!.subject,body:'Changed legacy promise.\n\nSam Example\nCallie'},RECAP_AT))).toMatchObject({ok:true,value:{approvalRequired:true,approvedAt:null}});
});
it('refuses a retired claim at the real dispatch boundary with zero provider submissions',async()=>{
 const {meetingDispatchFixture}=await import('./support/meetingDispatchFixture.ts');
 const {dispatchOutboundMessage}=await import('../../outbound/send.ts');
 const {verifyMeetingFence}=await import('../../meetings/followThroughDelivery.ts');
 const f=await meetingDispatchFixture({material:'Callie coordinates maintenance requests.'});stop=()=>f.world.stop();
 const fact=await withTransaction(f.db,()=>saveAnswerBlock(f.admin,{kind:'product',text:'Callie coordinates maintenance requests.'}));if(!fact.ok)throw new Error(fact.reason);await withTransaction(f.db,()=>approveAnswerBlock(f.admin,fact.value));
 const v=(await readMeetingFollowThrough(f.admin,{meetingId:f.meetingId}))!;
 expect(await withTransaction(f.db,()=>editMeetingRecap(f.admin,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'approve',expectedApprovalHash:v.approvalHash!},f.at))).toMatchObject({ok:true,value:{facts:[expect.objectContaining({id:fact.value.id,version:1})]}});
 const fence=await f.prepare();await withTransaction(f.db,()=>retireAnswerBlock(f.admin,fact.value));
 expect(await verifyMeetingFence(f.context,{fenceId:fence.id,at:f.at})).toMatchObject({ok:false,reason:'facts_block_retired'});
 const gmail=f.world.clientWith(f.world.alpha,{});
 expect((await dispatchOutboundMessage(f.context,f.world.sendDeps(f.world.alpha,{gmail,now:()=>new Date(f.at)}),{outboundMessageId:fence.id})).outcome).not.toBe('sent');
 expect(gmail.sends).toHaveLength(0);
});
it('refuses a stale approval preview when a matching fact appears without a plan revision',async()=>{
 const f=await meetingFollowThroughFixture();stop=()=>f.db.drop();const p=await f.ready({body:'Thanks.\n\n{meeting_recap}\n\nCallie coordinates maintenance requests.\n\nSam Example\nCallie'});
 const prepared=await withTransaction(f.db.session,()=>prepareMeetingRecap(f.context,{...p,at:RECAP_AT}));if(!prepared.ok)throw new Error(prepared.reason);const v=prepared.value;
 const saved=await withTransaction(f.db.session,()=>saveAnswerBlock(f.context,{kind:'product',text:'Callie coordinates maintenance requests.'}));if(!saved.ok)throw new Error(saved.reason);await withTransaction(f.db.session,()=>approveAnswerBlock(f.context,saved.value));
 expect(await withTransaction(f.db.session,()=>editMeetingRecap(f.context,{planId:v.planId!,expectedPlanVersion:v.version,expectedDraftVersion:v.currentDraft!.version,action:'approve',expectedApprovalHash:v.approvalHash!},RECAP_AT))).toMatchObject({ok:false,reason:'approval_changed'});
 expect((await readMeetingFollowThrough(f.context,{meetingId:p.meetingId}))!.approvalRequired).toBe(true);
});
