import {expect,it} from 'vitest';
import type {MeetingPreparationResponse} from '@fss/contracts';
import {createAuthedClient} from '../src/main/authedClient.ts';
import {answerOperation,operationHandlers,type OperationHostDeps} from '../src/main/operationHost.ts';

const meetingId='11111111-1111-4111-8111-111111111111';
const firmId='22222222-2222-4222-8222-222222222222';
const empty={items:[],omitted:0};
const preparation:MeetingPreparationResponse={
 meetingId,firmId,meeting:{title:'Introductory call',attendeeName:null,state:'booked',startsAt:'2026-10-09T15:00:00Z',endsAt:'2026-10-09T15:20:00Z',locationType:'link'},
 sections:{whyThisDemo:empty,firm:empty,conversations:empty,objections:empty,commitments:empty,
  workflow:{items:[{label:'Known workflow',text:'Our manager coordinates vendors.',source:'booking_answer',provenance:'stated',at:'2026-10-08T15:00:00Z',sourceUrl:null}],omitted:0},
  openQuestions:empty,objective:empty},generatedAt:'2026-10-08T15:00:00Z',
};

it('reads source-backed preparation through the authenticated negotiated brief operation',async()=>{
 const requests:string[]=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url)=>{requests.push(url);return {status:200,body:preparation};}});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','meetings.brief',{meetingId})).toEqual({brief:preparation,reason:null});
 expect(requests).toEqual([`https://api.example.test/meetings/brief?meetingId=${meetingId}&include=meeting_tasks&version=2`]);
});

it('refuses preparation returned after the signed-in identity changes',async()=>{
 let generation=0;
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async()=>{generation++;return {status:200,body:preparation};}});
 const deps={api,recordings:{identity:{current:()=>generation}}} as unknown as OperationHostDeps;
 expect(await answerOperation(operationHandlers(deps),'read','meetings.brief',{meetingId})).toEqual({brief:null,reason:'not_found'});
});


it('reads approval details and submits exact-preview approval through negotiated recap operations',async()=>{
 const view={meetingId,firmId,contactId:null,planId:'33333333-3333-4333-8333-333333333333',version:1,sourceHash:'a'.repeat(64),notesRevision:1,sequenceVersionId:null,status:'held',currentDraft:null,scope:null,blockers:['approval_required'],sendingPaused:true,plannedSteps:[],sentMessages:[],approvalRequired:true,approvalHash:'b'.repeat(64),approvedAt:null,facts:[],plannedMessages:[]};
 const requests:Array<{url:string;body:unknown}>=[];
 const api=createAuthedClient({baseUrl:'https://api.example.test',clientVersion:'1.0.49',accessToken:async()=>({token:'fixture',generation:0}),send:async(url,init)=>{requests.push({url,body:init.body});return {status:200,body:init.method==='POST'?{status:'accepted',replayed:false,result:view}:view};}});
 const deps={api,recordings:{identity:{current:()=>0}}} as unknown as OperationHostDeps;
 const handlers=operationHandlers(deps);
 expect(await answerOperation(handlers,'read','meetings.followThrough',{meetingId})).toEqual({view,reason:null});
 expect(await answerOperation(handlers,'command','meetings.editRecap',{planId:view.planId,expectedPlanVersion:1,expectedDraftVersion:1,action:'approve',expectedApprovalHash:view.approvalHash,commandId:'44444444-4444-4444-8444-444444444444'})).toEqual({view,reason:null});
 expect(requests.map(request=>request.url)).toEqual([`https://api.example.test/meetings/follow-through?meetingId=${meetingId}&version=2`,'https://api.example.test/meetings/recap/edit?version=2']);
 expect(JSON.parse(String(requests[1]?.body))).toMatchObject({action:'approve',expectedApprovalHash:view.approvalHash});
});
