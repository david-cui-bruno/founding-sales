// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import type {SocialPrivateDraftMetadata} from '@fss/contracts';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialWorkspace} from '../../src/client/BrowserSocialWorkspace.tsx';
import {PRIVATE_DRAFT_PENDING_KEY} from '../../src/client/PrivateDraftCustody.ts';
const ownerId='10000000-0000-4000-8000-000000000001';
const firstId='20000000-0000-4000-8000-000000000002';
const secondId='30000000-0000-4000-8000-000000000003';
const newId='40000000-0000-4000-8000-000000000004';
const json=(value:unknown)=>new Response(JSON.stringify(value));
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {resolve,promise};}
function fixture(){
 const now=Date.now(),createdAt=new Date(now).toISOString(),expiresAt=new Date(now+86400000).toISOString();
 const metadata=(draftId:string):SocialPrivateDraftMetadata=>({draftId,revision:1,kind:'post',originKind:'manual',availability:'available',createdAt,updatedAt:createdAt,expiresAt});
 let drafts=[metadata(firstId),metadata(secondId)];
 let session={status:'signed_in',workspaceId:ownerId,userId:ownerId,deviceId:ownerId,role:'admin',revision:'social-workspace',csrfToken:'c'.repeat(40),expiresAt:new Date(now+120000).toISOString()};
 let refused=false,unknown=false,unavailable=false,wrongIdentity=false,paged=false,listUnavailable=false;
 let held:ReturnType<typeof deferred>|null=null;
 const commands:Record<string,unknown>[]=[],reads:{route:string;body:Record<string,unknown>}[]=[];
 const texts=new Map([[firstId,'First neutral owner draft.'],[secondId,'Second neutral owner draft.']]);
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session);
  if(url==='/browser/logout')return json({status:'signed_out'});
  const route=String(url),body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  reads.push({route,body});
  if(route.endsWith('/private-drafts/list'))return json(paged?{drafts:drafts.filter(draft=>draft.draftId===(body['afterId']?secondId:firstId)),nextAfterId:body['afterId']?null:firstId}:{drafts:listUnavailable?drafts.map(draft=>({...draft,availability:'unavailable'})):drafts,nextAfterId:null});
  if(route.endsWith('/private-drafts/read')){
   if(held)return held.promise;
   const draft=drafts.find(item=>item.draftId===body['draftId'])!;
   if(unavailable)return json({draft:{...draft,availability:'unavailable',reason:'source_changed_or_unavailable'}});
   return json({draft:{...draft,draftId:wrongIdentity?secondId:draft.draftId,text:texts.get(draft.draftId),origin:{kind:'manual'},reviewRequired:true}});
  }
  if(route.endsWith('/private-drafts/save')){
   commands.push(body);
   if(unknown)throw Error('Lost response');
   if(refused)return json({status:'refused',replayed:false,reason:'stale_revision'});
   const draftId=body['operation']==='create'?newId:String(body['draftId']);
   const old=drafts.find(item=>item.draftId===draftId)!;
   const revision=body['operation']==='create'?1:old.revision+1;
   const kind=body['kind']==='comment'?'comment':'post';
   texts.set(draftId,String(body['text']));drafts=body['operation']==='create'?[{...metadata(newId),kind},...drafts]:drafts.map(item=>item.draftId===draftId?{...item,revision,kind}:item);
   return json({status:'accepted',replayed:false,result:{draftId,revision}});
  }
  if(route.endsWith('/private-drafts/receipt'))return json({state:'unknown'});
  throw Error('Unexpected route');
 });
 const client=new BrowserClient({storage:localStorage,fetch,navigate:vi.fn(),randomUUID:()=>ownerId});
 return {client,reads,commands,metadata,page:()=>{paged=true;},hold:()=>{held=deferred();return held;},refuse:()=>{refused=true;},loseResponse:()=>{unknown=true;},withhold:()=>{unavailable=true;},withholdList:()=>{listUnavailable=true;},wrongIdentity:()=>{wrongIdentity=true;},changeSession:()=>{session={...session,revision:'replaced'};},setDrafts:(next:typeof drafts)=>{drafts=next;}};
}
beforeEach(()=>{
 vi.stubGlobal('crypto',webcrypto);
 let queue=Promise.resolve<unknown>(undefined);
 vi.stubGlobal('navigator',{locks:{request:(_name:string,_options:unknown,work:()=>Promise<unknown>)=>{const result=queue.then(work);queue=result.catch(()=>undefined);return result;}}});
});
afterEach(()=>{cleanup();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
const text=()=>screen.getByLabelText('Private social text');
const reopen=(id=firstId)=>fireEvent.click(screen.getByRole('button',{name:new RegExp(`Reopen private draft ${id}`,'u')}));
async function mount(){const s=fixture();await s.client.refresh();const view=render(<BrowserSocialWorkspace client={s.client}/>);await screen.findByRole('button',{name:new RegExp(`Reopen private draft ${firstId}`,'u')});return {...s,view};}
it('loads actual metadata only, explicitly reopens one exact draft, and retains the list beside one editor',async()=>{
 const s=await mount();expect(s.reads.map(read=>read.route)).toEqual(['/browser/api/social/private-drafts/list']);
 expect(text()).toHaveProperty('value','');expect(screen.getAllByRole('textbox')).toHaveLength(1);
 reopen();await waitFor(()=>expect(text()).toHaveProperty('value','First neutral owner draft.'));
 const list=screen.getByRole('complementary',{name:'Saved private drafts'});
 expect(within(list).queryByText('First neutral owner draft.')).toBeNull();expect(within(list).getAllByRole('button')).toHaveLength(3);
 expect(s.reads.at(-1)?.body).toEqual({draftId:firstId});
 expect(within(list).getByRole('button',{pressed:true}).getAttribute('aria-label')).toContain(firstId);
 reopen(secondId);await waitFor(()=>expect(text()).toHaveProperty('value','Second neutral owner draft.'));
 expect(screen.getAllByRole('textbox')).toHaveLength(1);expect(within(list).getByRole('button',{pressed:true}).getAttribute('aria-label')).toContain(secondId);s.client.dispose();
});
it('saves through real client custody/CAS and explicitly reopens persisted content after remount',async()=>{
 const s=await mount();reopen();await waitFor(()=>expect(text()).toHaveProperty('value','First neutral owner draft.'));
 fireEvent.change(text(),{target:{value:'Edited neutral private text.'}});expect(screen.getByText('Revision 1 · Unsaved changes')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));await screen.findByText('Private draft saved at revision 2. Not approved, scheduled or published.');
 expect(s.commands).toHaveLength(1);expect(s.commands[0]).toMatchObject({operation:'update',draftId:firstId,expectedRevision:1,text:'Edited neutral private text.'});
 expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBeNull();
 s.view.unmount();render(<BrowserSocialWorkspace client={s.client}/>);await screen.findByRole('button',{name:new RegExp(`Reopen private draft ${firstId}`,'u')});expect(text()).toHaveProperty('value','');
 reopen();await waitFor(()=>expect(text()).toHaveProperty('value','Edited neutral private text.'));expect(s.commands).toHaveLength(1);s.client.dispose();
});
it('keeps manual conflict edits visibly unsaved and never overwrites without a new explicit operation',async()=>{
 const s=await mount();reopen();await waitFor(()=>expect(text()).toHaveProperty('value','First neutral owner draft.'));s.refuse();
 fireEvent.change(text(),{target:{value:'Conflict scratch only.'}});fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));
 await screen.findByText(/Private save refused: stale_revision/u);expect(text()).toHaveProperty('value','Conflict scratch only.');expect(screen.getByText('Revision 1 · Unsaved changes')).toBeTruthy();expect(s.commands).toHaveLength(1);s.client.dispose();
});
it('holds UNKNOWN across view unmount and IDs-only reconciliation, never reminting or storing prose',async()=>{
 const s=await mount();s.loseResponse();fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));fireEvent.change(text(),{target:{value:'Neutral unknown-save text.'}});fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));
 await screen.findByText(/Private operation unavailable or outcome unknown/u);const held=localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY);expect(held).not.toContain('Neutral unknown-save text.');expect(held).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Conversations'}));fireEvent.click(screen.getByRole('button',{name:'Posts'}));await screen.findByRole('button',{name:'Reconcile same private save'});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Reconcile same private save'}).hasAttribute('disabled')).toBe(false));
 expect(text()).toHaveProperty('value','');expect(screen.queryByRole('button',{name:'Retry exact same private save'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Reconcile same private save'}));await screen.findByText(/Save outcome UNKNOWN/u);expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBe(held);expect(s.commands).toHaveLength(1);
 expect(screen.getByRole('button',{name:'Save private draft'}).hasAttribute('disabled')).toBe(true);expect(screen.getByRole('button',{name:'Start new manual draft'}).hasAttribute('disabled')).toBe(true);
 expect(s.reads.at(-1)?.body).toEqual(expect.objectContaining({commandId:expect.any(String),payloadSHA256:expect.any(String)}));expect(Object.keys(s.reads.at(-1)!.body).sort()).toEqual(['commandId','payloadSHA256']);s.client.dispose();
});
it('offers honest public-discussion unavailability, no fictional DMs or connection/publishing actions',async()=>{
 const s=await mount();fireEvent.change(text(),{target:{value:'Unsaved private bytes.'}});const before=s.reads.length;
 fireEvent.click(screen.getByRole('button',{name:'Conversations'}));expect(screen.getByText('Public posts and group discussions, not direct messages.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Open public discussion'}).hasAttribute('disabled')).toBe(true);expect(s.reads).toHaveLength(before);expect(screen.queryByLabelText('Private social text')).toBeNull();
 expect(screen.queryByRole('button',{name:/publish|connect|send|schedule/iu})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Posts'}));await screen.findByRole('button',{name:new RegExp(`Reopen private draft ${firstId}`,'u')});expect(text()).toHaveProperty('value','');s.client.dispose();
});
it('Back preserves mounted unsaved text and new composition clears identity',async()=>{
 const s=await mount();reopen();await waitFor(()=>expect(text()).toHaveProperty('value','First neutral owner draft.'));fireEvent.change(text(),{target:{value:'Mounted unsaved edit.'}});
 fireEvent.click(screen.getByRole('button',{name:'Back to drafts'}));expect(text()).toHaveProperty('value','Mounted unsaved edit.');
 fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));expect(text()).toHaveProperty('value','');expect(screen.getByText('New private draft')).toBeTruthy();expect(screen.getByRole('complementary',{name:'Saved private drafts'}).querySelector('[aria-pressed="true"]')).toBeNull();s.client.dispose();
});
it('Back focus runs only after the committed list-visible class with mounted enabled target',async()=>{
 const s=await mount();fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));
 const editor=text(),list=screen.getByRole('button',{name:'List saved private drafts'});
 fireEvent.change(editor,{target:{value:'Mounted focus-regression scratch.'}});
 const committed: boolean[]=[];
 vi.spyOn(list,'focus').mockImplementation(()=>{committed.push(list.isConnected&&!list.hasAttribute('disabled')&&!list.closest('.social-composition')!.classList.contains('social-editor-open'));});
 expect(list.closest('.social-composition')!.classList.contains('social-editor-open')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Back to drafts'}));
 expect(committed).toEqual([true]);expect(text()).toBe(editor);expect(editor).toHaveProperty('value','Mounted focus-regression scratch.');expect(s.commands).toEqual([]);s.client.dispose();
});
it('Back supersedes pending editor focus without a later callback stealing list focus',async()=>{
 const frames:FrameRequestCallback[]=[];vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{frames.push(callback);return frames.length;});
 const s=await mount();fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));
 const list=screen.getByRole('button',{name:'List saved private drafts'});
 fireEvent.click(screen.getByRole('button',{name:'Back to drafts'}));
 act(()=>{for(const frame of frames)frame(0);});
 expect(document.activeElement).toBe(list);expect(list.closest('.social-editor-open')).toBeNull();s.client.dispose();
});
it('a same-turn Back and reopen never restores stale list focus after the newer editor transition',async()=>{
 const s=await mount();const start=screen.getByRole('button',{name:'Start new manual draft'});fireEvent.click(start);
 const list=screen.getByRole('button',{name:'List saved private drafts'}),focus=vi.spyOn(list,'focus');
 const back=screen.getByRole('button',{name:'Back to drafts'});
 act(()=>{back.click();start.click();});
 expect(focus).not.toHaveBeenCalled();expect(list.closest('.social-editor-open')).not.toBeNull();s.client.dispose();
});
it.each(['unavailable','wrong identity'] as const)('never restores prose after %s selected read',async mode=>{
 const s=await mount();if(mode==='unavailable')s.withhold();else s.wrongIdentity();reopen();await screen.findByText(mode==='unavailable'?/Private draft unavailable: source_changed_or_unavailable/u:/Private operation unavailable or outcome unknown/u);expect(text()).toHaveProperty('value','');expect(s.commands).toEqual([]);s.client.dispose();
});
it('scope replacement fences a held selected read and clears list and editor',async()=>{
 const s=await mount(),held=s.hold();reopen();await waitFor(()=>expect(s.reads.at(-1)?.route).toBe('/browser/api/social/private-drafts/read'));
 s.changeSession();await act(async()=>{await expect(s.client.refresh()).rejects.toThrow('session_changed');});await act(async()=>{held.resolve(json({draft:{...s.metadata(firstId),text:'Late old-scope private text.',origin:{kind:'manual'},reviewRequired:true}}));});
 expect(screen.queryByLabelText('Private social text')).toBeNull();expect(screen.queryByRole('complementary',{name:'Saved private drafts'})).toBeNull();s.client.dispose();
});
it('empty persisted list permits a new private composition without sources, account, or provider',async()=>{
 const s=fixture();s.setDrafts([]);await s.client.refresh();render(<BrowserSocialWorkspace client={s.client}/>);await screen.findByText('No saved private drafts. Start a new manual draft.');
 fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));fireEvent.change(text(),{target:{value:'Manual neutral composition.'}});expect(s.reads).toHaveLength(1);expect(s.commands).toEqual([]);expect(screen.getByText('First save starts a maximum 90-day lifetime. · Human review required')).toBeTruthy();s.client.dispose();
});
it('new manual comment uses create then authorized readback and adds only actual metadata to the list',async()=>{
 const s=await mount();fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));fireEvent.change(screen.getByLabelText('Scratch format'),{target:{value:'comment'}});fireEvent.change(text(),{target:{value:'Neutral private comment.'}});
 fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));await screen.findByText('Private draft saved at revision 1. Not approved, scheduled or published.');
 expect(s.commands[0]).toMatchObject({operation:'create',kind:'comment',origin:{kind:'manual'},text:'Neutral private comment.'});expect(s.commands[0]).not.toHaveProperty('accountId');
 expect(s.reads.slice(-2)).toEqual([{route:'/browser/api/social/private-drafts/read',body:{draftId:newId}},{route:'/browser/api/social/private-drafts/list',body:{}}]);expect(text()).toHaveProperty('value','Neutral private comment.');
 expect(screen.getByRole('button',{name:new RegExp(`Reopen private draft ${newId}`,'u')})).toBeTruthy();expect(screen.getByRole('complementary',{name:'Saved private drafts'}).textContent).not.toContain('Neutral private comment.');s.client.dispose();
});
it('uses the real list cursor and preserves exact selected editor across metadata pages',async()=>{
 const s=fixture();s.page();await s.client.refresh();render(<BrowserSocialWorkspace client={s.client}/>);await screen.findByRole('button',{name:'Next private drafts'});reopen();await waitFor(()=>expect(text()).toHaveProperty('value','First neutral owner draft.'));
 fireEvent.click(screen.getByRole('button',{name:'Next private drafts'}));await screen.findByRole('button',{name:new RegExp(`Reopen private draft ${secondId}`,'u')});expect(s.reads.at(-1)?.body).toEqual({afterId:firstId});
 expect(text()).toHaveProperty('value','First neutral owner draft.');expect(screen.queryByRole('button',{name:'Next private drafts'})).toBeNull();s.client.dispose();
});
it('does not mask source-withheld current readback with an accepted historical save notice',async()=>{
 const s=await mount();reopen();await waitFor(()=>expect(text()).toHaveProperty('value','First neutral owner draft.'));s.withhold();fireEvent.change(text(),{target:{value:'No longer visible after source refusal.'}});fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));
 await screen.findByText(/Private draft unavailable: source_changed_or_unavailable/u);expect(screen.queryByText('Private draft saved at revision 2. Not approved, scheduled or published.')).toBeNull();expect(text()).toHaveProperty('value','');expect(localStorage.getItem(PRIVATE_DRAFT_PENDING_KEY)).toBeNull();s.client.dispose();
});
it('clears even a newly created selected draft if the following list reports current source loss',async()=>{
 const s=await mount();s.withholdList();fireEvent.click(screen.getByRole('button',{name:'Start new manual draft'}));fireEvent.change(text(),{target:{value:'New private save before current list refusal.'}});fireEvent.click(screen.getByRole('button',{name:'Save private draft'}));
 await screen.findByText('Selected private draft is no longer available. Private text cleared.');expect(text()).toHaveProperty('value','');expect(screen.getByText('New private draft')).toBeTruthy();expect(s.commands).toHaveLength(1);s.client.dispose();
});
