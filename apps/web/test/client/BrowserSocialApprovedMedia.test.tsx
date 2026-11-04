// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserSocialApprovedMedia,type SocialMediaBrowserPort,type MediaPoolItem} from '../../src/client/BrowserSocialApprovedMedia.tsx';
afterEach(cleanup);
const item:MediaPoolItem={assetId:'10000000-0000-4000-8000-000000000001',version:2,sha256:'b'.repeat(64),approvalRevision:0,caption:'',topic:'',altText:'',width:20,height:10,mime:'image/jpeg',approved:false};
function setup(){let invalidate=()=>{};const port:SocialMediaBrowserPort={read:vi.fn(async()=>[item]),upload:vi.fn(async()=>{}),preview:vi.fn(async()=>({url:'https://private.example.test/sanitized',expiresAt:new Date(Date.now()+600000).toISOString()})),approve:vi.fn(async()=>{}),remove:vi.fn(async()=>{}),reconcile:vi.fn(async()=>'unknown' as const),subscribe:callback=>{invalidate=callback;return()=>{};}};render(<BrowserSocialApprovedMedia port={port}/>);return {port,invalidate:()=>invalidate()};}
async function inspect(){fireEvent.click(screen.getByRole('button',{name:'Read current media'}));const select=await screen.findByRole('button',{name:'Unapproved image — needs approval'});await waitFor(()=>expect(select).toHaveProperty('disabled',false));fireEvent.click(select);await screen.findByRole('img');await waitFor(()=>expect(screen.getByRole('button',{name:'Read current media'})).toHaveProperty('disabled',false));}
it('requires a loaded exact sanitized preview and explicit clearance; sends version/digest/alt text',async()=>{
 const s=setup();await inspect();const approve=screen.getByRole('button',{name:'Approve exact preview for my posts'});
 fireEvent.change(screen.getByLabelText('Caption'),{target:{value:'A release screenshot'}});fireEvent.change(screen.getByLabelText('Topic'),{target:{value:'engineering'}});fireEvent.change(screen.getByLabelText('Accurate alt text'),{target:{value:'A blue rectangle'}});
 fireEvent.click(screen.getByRole('checkbox'));expect(approve).toHaveProperty('disabled',true);fireEvent.load(screen.getByRole('img'));expect(approve).toHaveProperty('disabled',false);fireEvent.click(approve);
 await waitFor(()=>expect(s.port.approve).toHaveBeenCalledWith({assetId:item.assetId,version:2,sha256:item.sha256,expectedApprovalRevision:0,caption:'A release screenshot',topic:'engineering',altText:'A blue rectangle',publicUseClearance:true}));
});
it('scope invalidation clears previews and editable metadata, and late reads cannot repopulate it',async()=>{
 const s=setup();await inspect();fireEvent.change(screen.getByLabelText('Caption'),{target:{value:'Private current caption'}});act(()=>s.invalidate());expect(screen.queryByRole('img')).toBeNull();expect(screen.queryByDisplayValue('Private current caption')).toBeNull();expect(screen.queryByRole('button',{name:'Unapproved image — needs approval'})).toBeNull();
 const held=Promise.withResolvers<MediaPoolItem[]>();s.port.read=vi.fn(()=>held.promise);fireEvent.click(screen.getByRole('button',{name:'Read current media'}));act(()=>s.invalidate());await act(async()=>held.resolve([item]));expect(screen.queryByRole('button',{name:'Unapproved image — needs approval'})).toBeNull();
});
it('withdrawal uses current approval CAS and recovery never automatically remints a write',async()=>{
 const s=setup();await inspect();fireEvent.click(screen.getByRole('button',{name:'Withdraw and remove'}));await waitFor(()=>expect(s.port.remove).toHaveBeenCalledWith({assetId:item.assetId,expectedApprovalRevision:0}));await screen.findByText(/Withdrawn immediately/u);
 fireEvent.click(screen.getByRole('button',{name:'Reconcile uncertain media command'}));await screen.findByText(/Outcome UNKNOWN/u);expect(s.port.approve).not.toHaveBeenCalled();expect(s.port.upload).not.toHaveBeenCalled();expect(s.port.remove).toHaveBeenCalledTimes(1);
});
