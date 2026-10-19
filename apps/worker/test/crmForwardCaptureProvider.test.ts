import {expect,it} from 'vitest';
import {createGmailMailCaptureProvider} from '@fss/domain/mail/crmGmailProvider.ts';
import {createGmailHttpClient} from '@fss/domain/mail/gmailClientHttp.ts';
import {forwardCaptureScopeForApproval} from '@fss/domain/mail/crmForwardCaptureScope.ts';
import type {MailCaptureProof} from '@fss/domain/mail/crmSources.ts';
const cutoff='2026-10-18T22:33:00.001Z';
const proof:MailCaptureProof={workspaceId:'00000000-0000-4000-8000-000000000001',mailboxId:'00000000-0000-4000-8000-000000000002',ownerUserId:'00000000-0000-4000-8000-000000000003',providerAccountId:'owner@example.test',accountBinding:'fixture-binding',generation:1,controlsRevision:2,policyRevision:2,disclosureVersion:'fixture',disclosureSha256:'a'.repeat(64),grantReceipt:null,providerPolicyReceipt:null,evaluationReceipt:null,releaseReceipt:null,captureVersion:'crm-mail-capture-v1'};
function harness(at:unknown,options:{epoch?:boolean;sent?:boolean;selected?:boolean;revoke?:boolean;thread?:string}={}){
 let bodies=0,authority=true,checks=0;
 const thread=options.thread??'fixture_thread';
 const gmail=createGmailHttpClient({apiBaseUrl:'https://fixture.invalid',fetch:async url=>{
  const full=new URL(url).searchParams.get('format')==='full';if(full)bodies++;
  return {status:200,headers:{},body:JSON.stringify({id:'fixture_message',threadId:thread,internalDate:at,labelIds:[options.sent?'SENT':'INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'person@example.test'},{name:'To',value:'owner@example.test'},{name:'Date',value:'Sun, 18 Oct 2099 23:00:00 +0000'}],body:full?{data:Buffer.from('fictional business message').toString('base64url')}:{}}})};
 }});
 const provider=createGmailMailCaptureProvider({gmail,authorizeRead:async()=>{checks++;if(options.revoke&&checks>1)authority=false;return authority;},resolveAccess:async()=>({mailboxId:proof.mailboxId,providerAccountId:proof.providerAccountId,generation:1,access:{accessToken:'fictional-only',expiresAtEpochSeconds:Date.now()/1000+3600}}),
  ...(options.selected?{authorizeSelectedMetadata:async(current:MailCaptureProof,metadata:Awaited<ReturnType<typeof gmail.getMetadata>>)=>authority&&current.grantReceipt==='fictional-diagnostic-selection'&&metadata?.id==='fixture_message'&&metadata.threadId==='fixture_thread'&&metadata.internalDateEpochMilliseconds===Date.parse('2026-01-01T00:00:00Z')}:{}),
 });
 const p={...proof,...options.epoch?{forwardScope:{mode:'forward_only' as const,enabledAt:cutoff}}:{},...options.selected?{grantReceipt:'fictional-diagnostic-selection'}:{}};
 return {read:()=>provider.read({workspaceId:proof.workspaceId,mailboxId:proof.mailboxId,providerMessageId:'fixture_message',providerAccountId:proof.providerAccountId,generation:1,expectedProof:p}),bodies:()=>bodies};
}
it('derives the exact first whole millisecond strictly after the immutable DB timestamp',()=>{
 expect(forwardCaptureScopeForApproval('2026-10-18T22:33:00.000001Z')).toEqual({mode:'forward_only',enabledAt:cutoff});
 expect(forwardCaptureScopeForApproval('2026-10-18T22:33:00.000000Z')).toEqual({mode:'forward_only',enabledAt:cutoff});
 expect(forwardCaptureScopeForApproval('not-a-date')).toBeNull();
});
it.each([undefined,'invalid',String(Date.parse(cutoff)-1),'1.5','9007199254740992'])('refuses original INTERNAL date %s before body, irrespective of Date header',async at=>{
 const h=harness(at,{epoch:true});await expect(h.read()).rejects.toThrow();expect(h.bodies()).toBe(0);
});
it.each([false,true])('admits equal-cutoff incoming/Sent original with current authority (%s)',async sent=>{
 const h=harness(String(Date.parse(cutoff)),{epoch:true,sent});await expect(h.read()).resolves.toMatchObject({origin:sent?'sent':'received',providerAt:cutoff});expect(h.bodies()).toBe(1);
});
it('refuses missing ordinary epoch and revocation after metadata before body',async()=>{
 for(const opts of [{},{epoch:true,revoke:true}]){const h=harness(String(Date.parse(cutoff)),opts);await expect(h.read()).rejects.toThrow();expect(h.bodies()).toBe(0);}
});
it('preserves independently selected diagnostic original without granting ordinary older capture',async()=>{
 const at=String(Date.parse('2026-01-01T00:00:00Z'));
 const selected=harness(at,{selected:true});await expect(selected.read()).resolves.toMatchObject({messageId:'fixture_message'});expect(selected.bodies()).toBe(1);
 for(const opts of [{},{epoch:true},{selected:true,thread:'different_thread'}]){const h=harness(at,opts);await expect(h.read()).rejects.toThrow();expect(h.bodies()).toBe(0);}
});
