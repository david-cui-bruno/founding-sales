import {it,expect,vi} from 'vitest';
import {createSocialRuntime,socialPartition,socialNavigationAllowed,type SocialWindow,type SocialWindowOptions} from '../src/main/social/runtime.ts';
const scope={workspaceId:'workspace-a',userId:'owner-a',accountId:'account-a',platform:'linkedin' as const};
function harness(){const events=new Map<string,((...a:unknown[])=>void)[]>();const wcEvents=new Map<string,((...a:unknown[])=>void)[]>();let dead=false;const contents={on:vi.fn((n:string,f:(...a:unknown[])=>void)=>{wcEvents.set(n,[...(wcEvents.get(n)??[]),f]);}),setWindowOpenHandler:vi.fn(),session:{setPermissionRequestHandler:vi.fn(),setPermissionCheckHandler:vi.fn(),on:vi.fn(),clearStorageData:vi.fn(async()=>{})}};
 const window={webContents:contents,on:vi.fn((n:string,f:(...a:unknown[])=>void)=>events.set(n,[f])),loadURL:vi.fn(async()=>{}),destroy:vi.fn(()=>{dead=true;}),isDestroyed:()=>dead,hide:vi.fn(),show:vi.fn()};
 const create=vi.fn((_options:SocialWindowOptions)=>window as unknown as SocialWindow);return {create,window,contents,events,wcEvents};}
it('isolates account partitions and rejects external top-level navigation',()=>{
 expect(socialPartition(scope)).toMatch(/^persist:callie-social-[a-f0-9]{64}$/);
 for(const patch of [{workspaceId:'other'},{userId:'other'},{accountId:'other'},{platform:'x' as const}])expect(socialPartition({...scope,...patch})).not.toBe(socialPartition(scope));
 expect(socialNavigationAllowed('linkedin','https://www.linkedin.com/feed/')).toBe(true);
 for(const url of ['http://www.linkedin.com/','https://www.linkedin.com.evil.test/','file:///etc/passwd','https://x.com/home','https://evil@www.linkedin.com/'])expect(socialNavigationAllowed('linkedin',url)).toBe(false);
});
it('creates a hidden sandbox with no preload, Node, popup or permission capability',async()=>{
 const h=harness(),runtime=createSocialRuntime(h.create);
 await runtime.withAccount(scope,async()=>({ok:true}));
 expect(h.create).toHaveBeenCalledWith(expect.objectContaining({show:false,webPreferences:expect.objectContaining({sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,partition:socialPartition(scope)})}));
 expect(h.create.mock.calls[0]![0].webPreferences).not.toHaveProperty('preload');
 expect(h.window.show).not.toHaveBeenCalled();expect(h.window.destroy).toHaveBeenCalledTimes(1);
 expect(h.contents.setWindowOpenHandler.mock.calls[0]![0]()).toEqual({action:'deny'});
 expect(h.contents.session.setPermissionCheckHandler.mock.calls[0]![0]()).toBe(false);
 const answer=vi.fn();h.contents.session.setPermissionRequestHandler.mock.calls[0]![0](null,'camera',answer);expect(answer).toHaveBeenCalledWith(false);
 const event={preventDefault:vi.fn()};h.wcEvents.get('will-navigate')![0]!(event,'https://evil.test');expect(event.preventDefault).toHaveBeenCalled();
});
it('allows only one active task per account and invalidates it on sign-out',async()=>{
 const h=harness(),runtime=createSocialRuntime(h.create);let finish:()=>void=()=>{};let current:()=>boolean=()=>true;
 const pending=runtime.withAccount(scope,async session=>{current=session.isCurrent;await new Promise<void>(r=>{finish=r;});return {ok:true};});
 await vi.waitFor(()=>expect(h.window.loadURL).toHaveBeenCalled());
 await vi.waitFor(()=>expect(current()).toBe(true));
 expect(await runtime.withAccount(scope,async()=>({ok:true}))).toEqual({ok:false,reason:'account_busy'});
 runtime.signOut();expect(current()).toBe(false);finish();
 expect(await pending).toEqual({ok:false,reason:'session_changed'});expect(h.window.show).not.toHaveBeenCalled();
});

it('disconnect clears only its own account partition and invalidates pending work',async()=>{
 const h=harness(),runtime=createSocialRuntime(h.create);let finish:()=>void=()=>{};
 const pending=runtime.withAccount(scope,async()=>{await new Promise<void>(r=>{finish=r;});return {ok:true};});
 await vi.waitFor(()=>expect(h.window.loadURL).toHaveBeenCalled());
 await runtime.disconnect(scope);
 expect(h.contents.session.clearStorageData).toHaveBeenCalledTimes(1);
 finish();expect(await pending).toEqual({ok:false,reason:'session_changed'});
});
it('bounds a hung page load and destroys the hidden window',async()=>{
 vi.useFakeTimers();
 try {const h=harness();h.window.loadURL.mockImplementation(()=>new Promise(()=>{}));
 const runtime=createSocialRuntime(h.create);const pending=runtime.withAccount(scope,async()=>({ok:true}));
 await vi.advanceTimersByTimeAsync(30_001);
 expect(await pending).toEqual({ok:false,reason:'browser_unavailable'});expect(h.window.destroy).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
it('disconnect after restart clears the selected persisted partition without loading a page',async()=>{
 const h=harness(),runtime=createSocialRuntime(h.create);
 await runtime.disconnect(scope);
 expect(h.create).toHaveBeenCalledTimes(1);
 expect(h.create.mock.calls[0]![0].webPreferences.partition).toBe(socialPartition(scope));
 expect(h.contents.session.clearStorageData).toHaveBeenCalledTimes(1);
 expect(h.window.loadURL).not.toHaveBeenCalled();expect(h.window.destroy).toHaveBeenCalled();
});
it('cannot reopen an account while its session is being cleared',async()=>{
 const h=harness(),runtime=createSocialRuntime(h.create);let finish:()=>void=()=>{};
 h.contents.session.clearStorageData.mockImplementation(()=>new Promise<void>(r=>{finish=r;}));
 const clearing=runtime.disconnect(scope);
 expect(await runtime.withAccount(scope,async()=>true)).toEqual({ok:false,reason:'account_busy'});
 finish();await clearing;
});
it('shows a sandboxed login window only through the explicit connect operation',async()=>{
 const h=harness(),runtime=createSocialRuntime(h.create);
 const result=await runtime.connectAccount(scope,async session=>{expect(session.isCurrent()).toBe(true);expect(h.window.show).toHaveBeenCalledTimes(1);return {connected:true};});
 expect(result).toEqual({connected:true});expect(h.window.destroy).toHaveBeenCalledTimes(1);
 expect(h.create.mock.calls[0]![0].webPreferences).not.toHaveProperty('preload');
 expect(h.create.mock.calls[0]![0].webPreferences.partition).toBe(socialPartition(scope));
});
it('bounds an abandoned connect operation and closes the login window',async()=>{
 vi.useFakeTimers();try{
 const h=harness(),runtime=createSocialRuntime(h.create);
 const result=runtime.connectAccount(scope,async()=>new Promise(()=>{}));
 await vi.advanceTimersByTimeAsync(600_001);
 expect(await result).toEqual({ok:false,reason:'browser_unavailable'});expect(h.window.destroy).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});
it('reports a bounded load timeout without retaining the thrown page message',async()=>{
 vi.useFakeTimers();try{const h=harness();h.window.loadURL.mockImplementation(()=>new Promise(()=>{}));const report=vi.fn();const runtime=createSocialRuntime(h.create);const pending=runtime.withAccount(scope,async()=>true,report);await vi.advanceTimersByTimeAsync(30_001);expect(await pending).toEqual({ok:false,reason:'browser_unavailable'});expect(report).toHaveBeenLastCalledWith('browser_load','refused','load_timeout');}finally{vi.useRealTimers();}
});
