import {createHash,randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../../worker/src/bootstrap/main.ts';
import {dispatch} from '../../src/server.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './authFixture.ts';
import {issueSessionFor} from './sessionFixture.ts';
import {seedFirm,seedContact} from './crmSeed.ts';

/** Genuine canonical copied mail under controlled acquisition evidence, not real OAuth consent. */
export async function bookingCreateSourceFixture(){
 const fixture=await createAuthFixture();
 const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
 const db=await fixture.database.appRuntimeSession();
 const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
 const runtimeOptions:{bookingCreate?:import('@fss/domain/meetings/bookingCreateRuntime.ts').BookingCreateRuntime;bookingPolicyRuntime?:import('@fss/domain/meetings/bookingPolicyTypes.ts').BookingPolicyRuntime}={};
 const request=async(method:string,path:string,body?:unknown,session=db)=>{const url=new URL(path,'https://fixture.test');return dispatch({method,path:url.pathname,query:url.searchParams,body,headers:{authorization:`Bearer ${token}`}},{...runtimeOptions,session,auth:{...fixture.deps,db:session},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});};
 const firmId=await seedFirm(fixture,{name:'Booking-only source fixture',assignedUserId:fixture.alpha.admin.userId});
 const contactId=await seedContact(fixture,{firmId,fullName:'Agreed prospect'});
 const route=await request('POST','/contacts/routes/add',command({firmId,contactId,routeKind:'email',value:'prospect@booking.example',source:'salesperson',technicalValidation:'passed',associationConfidence:0.95}));
 expect(route.status).toBe(200);
 const attendeeRouteId=(route.body as {result:{id:string}}).result.id;
 const mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@booking.example','controlled-google','connected') RETURNING *",[fixture.alpha.workspaceId,fixture.alpha.admin.userId])).rows[0]!;
 const binding=businessAccountBinding(fixture.alpha.workspaceId,mailbox)!;
 await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'controlled-google',$4,1,1,false)",[fixture.alpha.workspaceId,mailbox.id,fixture.alpha.admin.userId,binding]);
 const conversationId=(await fixture.db.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'booking-thread','Agreed call','[]',now(),'business','fixture','fixture',$5) RETURNING id",[fixture.alpha.workspaceId,mailbox.id,fixture.alpha.admin.userId,binding,'a'.repeat(64)])).rows[0]!.id;
 await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'controlled-google',$4,1,1,true,1,'controlled-capture',$5,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[fixture.alpha.workspaceId,mailbox.id,fixture.alpha.admin.userId,binding,'b'.repeat(64)]);
 let sequence=0;
 async function capture(text:string,direction:'incoming'|'outgoing'='incoming'){
  const messageId=`booking-source-${++sequence}`;
  await enqueueJob(fixture.db,{workspaceId:fixture.alpha.workspaceId,kind:'crm.mail_capture',idempotencyKey:messageId,payload:{mailboxId:mailbox.id,providerMessageId:messageId,providerAccountId:'controlled-google',generation:1,conversationId,controlsRevision:1,policyRevision:1,decisionRevision:0}});
  const job=(await claimJobs(fixture.db,{owner:messageId,kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding},provider:{read:async()=>({providerAccountId:'controlled-google',messageId,threadId:'booking-thread',labels:direction==='incoming'?['INBOX']:['SENT'],origin:direction==='incoming'?'received':'sent',providerAt:direction==='incoming'?'2026-10-13T16:00:00.000Z':'2026-10-13T15:00:00.000Z',rawSenderDate:null,from:direction==='incoming'?'prospect@booking.example':'owner@booking.example',to:direction==='incoming'?['owner@booking.example']:['prospect@booking.example'],cc:[],subject:'Agreed call',body:text,parserVersion:'controlled-mime-v1',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:text.length,kind:'authored'}]})}}});
  const outcome=await registry.get('crm.mail_capture')!.handle({session:fixture.db,scope:workspaceScope(fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
  if(outcome===undefined||!('progress' in outcome)||outcome.progress['outcome']!=='captured')throw new Error(`capture_setup_failed:${JSON.stringify(outcome)}`);
  const sourceId=String(outcome.progress['sourceId']),contentHash=createHash('sha256').update(text).digest('hex');
  const source={sourceId,sourceRevision:1,contentHash};
  expect((await request('POST','/crm/business/mail/read',source)).body).toMatchObject({state:'available',source:{passage:text}});
  return source;
 }
 return {fixture,token,db,command,request,runtimeOptions,firmId,contactId,attendeeRouteId,mailbox,binding,capture};
}
