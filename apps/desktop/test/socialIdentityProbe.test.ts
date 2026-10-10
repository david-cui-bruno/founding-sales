import {expect,it,vi} from 'vitest';
import {probeLinkedInIdentity,probeLinkedInIdentityDetailed} from '../src/main/social/identityProbe.ts';
const identity={platform:'linkedin',externalAccountId:'https://www.linkedin.com/in/example/',displayName:'Example',accountKind:'profile'};
function port(){return {getURL:vi.fn(()=> 'https://www.linkedin.com/feed/'),executeJavaScriptInIsolatedWorld:vi.fn(async()=>identity)};}
it('runs a fixed read-only probe in an isolated world without user gesture',async()=>{
 const p=port();expect(await probeLinkedInIdentity(p,()=>true)).toEqual(identity);
 expect(p.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1001,[{code:expect.stringContaining('readLinkedInIdentity')}],false);
});
it('rejects sign-out or navigation during the read and malformed observations',async()=>{
 const p=port();let active=true;p.executeJavaScriptInIsolatedWorld.mockImplementation(async()=>{active=false;return identity;});
 expect(await probeLinkedInIdentity(p,()=>active)).toBeNull();
 const q=port();q.getURL.mockReturnValueOnce('https://www.linkedin.com/feed/').mockReturnValue('https://www.linkedin.com/login');expect(await probeLinkedInIdentity(q,()=>true)).toBeNull();
 for(const value of [null,{...identity,externalAccountId:'https://evil.test/'},{...identity,displayName:'x'.repeat(201)},{...identity,platform:'x'}]){
 const r=port();r.executeJavaScriptInIsolatedWorld.mockResolvedValue(value as typeof identity);expect(await probeLinkedInIdentity(r,()=>true)).toBeNull();
 }
});
it('does not execute after cancellation or on an unexpected page; DOM errors fail closed',async()=>{
 const p=port();expect(await probeLinkedInIdentity(p,()=>false)).toBeNull();expect(p.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
 p.getURL.mockReturnValue('https://evil.test');expect(await probeLinkedInIdentity(p,()=>true)).toBeNull();expect(p.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
 const q=port();q.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('destroyed'));expect(await probeLinkedInIdentity(q,()=>true)).toBeNull();
});
it('reports fixed body-free evidence categories while keeping unavailable separate from cancellation',async()=>{
 const p=port();p.executeJavaScriptInIsolatedWorld.mockResolvedValue({reason:'identity_sidebar_unavailable'} as never);
 expect(await probeLinkedInIdentityDetailed(p,()=>true)).toEqual({reason:'identity_sidebar_unavailable'});
 expect(await probeLinkedInIdentityDetailed(p,()=>false)).toEqual({reason:'session_changed'});
 p.getURL.mockReturnValue('https://www.linkedin.com/login');
 expect(await probeLinkedInIdentityDetailed(p,()=>true)).toEqual({reason:'identity_page_unavailable'});
 p.getURL.mockReturnValue('https://www.linkedin.com/feed/');p.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('private URL/name'));
 expect(await probeLinkedInIdentityDetailed(p,()=>true)).toEqual({reason:'identity_probe_unavailable'});
});
