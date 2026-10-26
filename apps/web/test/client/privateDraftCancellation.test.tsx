// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialReview} from '../../src/client/BrowserSocialReview.tsx';
import {PRIVATE_DRAFT_PENDING_KEY} from '../../src/client/PrivateDraftCustody.ts';
const id='10000000-0000-4000-8000-000000000001',draftId='20000000-0000-4000-8000-000000000002';
const json=(value:unknown)=>new Response(JSON.stringify(value));
afterEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals();});
it('mounted evidence refresh cancels sourced save UI but preserves same command for explicit reconciliation after late completion',async()=>{
 vi.stubGlobal('crypto',webcrypto);let queue=Promise.resolve<unknown>(undefined);
 vi.stubGlobal('navigator',{locks:{request:(_name:string,_options:unknown,work:()=>Promise<unknown>)=>{const result=queue.then(work);queue=result.catch(()=>undefined);return result;}}});
 const now=Date.now(),suggestion={id,state:'ready',sourceRefs:[],factBlocks:[],concepts:[{theme:'build',factRefs:[],variants:[{platform:'linkedin',text:'Retained sourced suggestion.'}]}],reason:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+600000).toISOString()};
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(now+120000).toISOString()};
 let complete!:(value:Response)=>void;const heldResponse=new Promise<Response>(resolve=>{complete=resolve;});const commands:Record<string,unknown>[]=[],receipts:unknown[]=[],currentReads:string[]=[];let known=false;
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session);
  if(url==='/browser/api/social/drafts')return json({sources:[],facts:[],requests:[suggestion]});
  if(url==='/browser/api/social/drafts/read')return json({request:suggestion});
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  if(url==='/browser/api/social/private-drafts/save'){commands.push(body);return heldResponse;}
  if(url==='/browser/api/social/private-drafts/receipt'){receipts.push(body);return json(known?{state:'accepted',result:{draftId,revision:1}}:{state:'unknown'});}
  if(url==='/browser/api/social/private-drafts/list')return json({drafts:[],nextAfterId:null});
  if(url==='/browser/api/social/private-drafts/read'){currentReads.push(String(body['draftId']));return json({draft:{draftId,revision:1,kind:'post',originKind:'suggestion',availability:'available',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400000).toISOString(),text:'Current explicitly reopened saved text.',origin:commands[0]?.['origin'],reviewRequired:true}});}
  throw Error('Unexpected route');
 });
 const client=new BrowserClient({storage:localStorage,fetch,navigate:vi.fn(),randomUUID:()=>id});
 try{
  await client.refresh();render(<BrowserSocialReview client={client}/>);fireEvent.click(screen.getByRole('button',{name:'Read retained social suggestions'}));await screen.findByRole('button',{name:'Re-read and use linkedin suggestion 1.1'});fireEvent.click(screen.getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save private draft'}).hasAttribute('disabled')).toBe(false));fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Edited source-dependent private bytes.'}});fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));await waitFor(()=>expect(commands).toHaveLength(1));
  const pending=localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY);expect(pending).not.toContain('Edited source-dependent');const identity=JSON.parse(pending!) as {commandId:string;payloadSHA256:string};expect(commands[0]?.['commandId']).toBe(identity.commandId);
  fireEvent.click(screen.getByRole('button',{name:'Read retained social suggestions'}));await screen.findByRole('button',{name:'Re-read and use linkedin suggestion 1.1'});expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');
  await waitFor(()=>expect(screen.getByRole('button',{name:'Reconcile same private save'}).hasAttribute('disabled')).toBe(false));
  await act(async()=>{complete(json({status:'accepted',replayed:false,result:{draftId,revision:1}}));});expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBe(pending);expect(currentReads).toEqual([]);expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');
  fireEvent.click(screen.getByRole('button',{name:'Reconcile same private save'}));await screen.findByText(/Save outcome UNKNOWN/u);expect(receipts).toEqual([{commandId:identity.commandId,payloadSHA256:identity.payloadSHA256}]);expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBe(pending);expect(screen.getByRole('button',{name:'Save private draft'}).hasAttribute('disabled')).toBe(true);expect(commands).toHaveLength(1);
  known=true;fireEvent.click(screen.getByRole('button',{name:'Reconcile same private save'}));await screen.findByText('Private draft saved at revision 1. Not approved, scheduled or published.');expect(receipts).toEqual([receipts[0],receipts[0]]);expect(commands).toHaveLength(1);expect(currentReads).toEqual([draftId]);expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBeNull();expect(screen.getByLabelText('Private social text')).toHaveProperty('value','Current explicitly reopened saved text.');
 }finally{complete(json({status:'accepted',replayed:false,result:{draftId,revision:1}}));client.dispose();}
});
