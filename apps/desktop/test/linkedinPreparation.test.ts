import {expect,it,vi} from 'vitest';
import {inspectLinkedInPreparation} from '../src/main/social/adapters/linkedinPreparation.ts';
const account={platform:'linkedin' as const,externalId:'profile',displayName:'Founder'};
function fixture(){let current=true;const ports={current:()=>current,account:vi.fn(async()=>account),openComposer:vi.fn(async()=>{}),wait:vi.fn(async()=>{}),contents:{executeJavaScriptInIsolatedWorld:vi.fn(async(_world:number,_scripts:{code:string}[],_gesture?:boolean)=>({ok:true,view:{kind:'composer',postingName:'Founder',text:''}}))}};return {...ports,stop:()=>{current=false;}};}
it('checks identity and composer without any write, schedule or submission capability',async()=>{const p=fixture();expect(await inspectLinkedInPreparation(account,p)).toEqual({ready:true});expect(p.account).toHaveBeenCalledTimes(2);expect(p.openComposer).toHaveBeenCalledTimes(1);expect(p.contents.executeJavaScriptInIsolatedWorld.mock.calls[0]![1][0]!.code).toContain('"action":"read"');});
it('preserves an existing draft and refuses identity or session changes',async()=>{const p=fixture();p.contents.executeJavaScriptInIsolatedWorld.mockResolvedValue({ok:true,view:{kind:'composer',postingName:'Founder',text:'private unfinished draft'}});expect(await inspectLinkedInPreparation(account,p)).toEqual({ready:false,reason:'existing_draft'});const q=fixture();q.account.mockResolvedValue({...account,externalId:'other'});expect(await inspectLinkedInPreparation(account,q)).toEqual({ready:false,reason:'account_identity_changed'});expect(q.openComposer).not.toHaveBeenCalled();});
it('bounds unavailable layouts and never returns raw DOM or errors',async()=>{const p=fixture();p.contents.executeJavaScriptInIsolatedWorld.mockResolvedValue({ok:false,view:{kind:'composer',postingName:'Secret',text:'secret'}});expect(await inspectLinkedInPreparation(account,p)).toEqual({ready:false,reason:'layout_changed'});expect(p.contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(12);});
it('bounds null identity evidence and refuses cancellation during a probe without opening the composer',async()=>{
 const p=fixture();const read=vi.fn(async()=>null);
 expect(await inspectLinkedInPreparation(account,{...p,account:read})).toEqual({ready:false,reason:'identity_unavailable'});
 expect(read).toHaveBeenCalledTimes(12);expect(p.wait).toHaveBeenCalledTimes(11);expect(p.openComposer).not.toHaveBeenCalled();
 const q=fixture();expect(await inspectLinkedInPreparation(account,{...q,account:async()=>{q.stop();return account;}})).toEqual({ready:false,reason:'session_changed'});expect(q.wait).not.toHaveBeenCalled();expect(q.openComposer).not.toHaveBeenCalled();
});
it('refuses disallowed page evidence immediately and checks navigation after the composer read',async()=>{
 const p=fixture();expect(await inspectLinkedInPreparation(account,{...p,probeAccount:async()=>({reason:'identity_page_unavailable'})})).toEqual({ready:false,reason:'identity_page_unavailable'});expect(p.wait).not.toHaveBeenCalled();expect(p.openComposer).not.toHaveBeenCalled();
 const q=fixture();let page=true;
 q.contents.executeJavaScriptInIsolatedWorld.mockImplementation(async()=>{page=false;return {ok:true,view:{kind:'composer',postingName:'Founder',text:''}};});
 expect(await inspectLinkedInPreparation(account,{...q,preparationCurrent:()=>true,current:()=>page})).toEqual({ready:false,reason:'identity_page_unavailable'});
});
