// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {SocialManualHandoff,type ManualHandoffPorts} from '../src/renderer/social/ManualHandoff.tsx';
afterEach(cleanup);
const view={postId:'post',revision:1,fingerprint:'a'.repeat(64),approvalId:null,approvedAt:null,state:'review_required' as const,accountEvidence:'human_review_required' as const,snapshot:{account:{id:'account',platform:'x' as const,externalId:'founder',displayName:'Founder',accountKind:'profile' as const,revision:1},text:'Approved observation.',images:[],publishAt:'2099-10-10T12:00:00Z',zone:'America/New_York'}};
it('requires explicit review and refreshes the approved handoff before copying exact text',async()=>{
 const use=vi.fn(async()=>{}),confirm=vi.fn<ManualHandoffPorts['confirm']>(async()=>({ok:true,value:{approvalId:'approval'}}));
 let approved=false;const ports:ManualHandoffPorts={read:async()=>({ok:true,value:approved?{...view,state:'manual_needed',approvalId:'approval'}:view}),confirm:async input=>{const result=await confirm(input);approved=true;return result;},use};
 render(<SocialManualHandoff postId='post' revision={1} ports={ports}/>);
 expect(await screen.findByText('Callie has not scheduled or published this post.')).toBeTruthy();
 expect((screen.getByRole('button',{name:'Approve manual handoff'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('I reviewed the exact destination, text, images and requested time.'));
 fireEvent.click(screen.getByRole('button',{name:'Approve manual handoff'}));
 fireEvent.click(await screen.findByRole('button',{name:'Copy approved text'}));
 await waitFor(()=>expect(use).toHaveBeenCalledWith({postId:'post',expectedRevision:1,fingerprint:view.fingerprint,approvalId:'approval',action:'copy'}));expect(confirm).toHaveBeenCalledWith({postId:'post',expectedRevision:1,fingerprint:view.fingerprint,reviewedDestination:true});
 expect(await screen.findByText('Text copied. Publication remains manual.')).toBeTruthy();
});

it('refuses a stale handoff before copying or opening a composer',async()=>{
 let reads=0;const use=vi.fn(async()=>{});
 const ports:ManualHandoffPorts={read:async()=>++reads===1?{ok:true,value:{...view,state:'manual_needed',approvalId:'approval'}}:{ok:false,reason:'schedule_in_past'},confirm:async()=>({ok:false,reason:'unused'}),use};
 render(<SocialManualHandoff postId='post' revision={1} ports={ports}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Copy approved text'}));
 expect(await screen.findByText('Time missed. Reschedule and approve this post again.')).toBeTruthy();expect(use).not.toHaveBeenCalled();
});

it('requires exact image previews before handoff review',async()=>{
 const image={assetId:'image',version:2,sha256:'b'.repeat(64),altText:'Dashboard',mime:'image/png',width:10,height:10};
 render(<SocialManualHandoff postId='post' revision={1} ports={{read:async()=>({ok:true,value:{...view,snapshot:{...view.snapshot,images:[image]}}}),confirm:async()=>({ok:false,reason:'unused'}),use:async()=>{}}} renderImage={(value,ready)=><img src='data:image/png;base64,iVBORw0KGgo=' alt={value.altText} onLoad={ready}/>}/>);
 fireEvent.click(await screen.findByLabelText('I reviewed the exact destination, text, images and requested time.'));
 expect((screen.getByRole('button',{name:'Approve manual handoff'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.load(screen.getByAltText('Dashboard'));expect((screen.getByRole('button',{name:'Approve manual handoff'}) as HTMLButtonElement).disabled).toBe(false);
});
