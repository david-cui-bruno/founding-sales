// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';import {SocialRoute,type SocialPorts} from '../src/renderer/social/SocialRoute.tsx';
afterEach(cleanup);
const account={id:'11111111-1111-4111-8111-111111111111',platform:'linkedin' as const,displayName:'David Cui',externalId:'david',accountKind:'profile' as const,state:'connected' as const,adapterVersion:'fixture-v1',verifiedAt:'2026-10-01T00:00:00Z'};
it('keeps a typed draft across route changes and does not approve it by saving',async()=>{
 const mutate=vi.fn(async(_input:Parameters<SocialPorts['mutate']>[0])=>({accepted:true,view:{accounts:[account],posts:[]},reason:null}));const ports:SocialPorts={read:async()=>({view:{accounts:[account],posts:[]},reason:null}),mutate};
 const Shell=({show}:{show:boolean})=><DraftsProvider>{show?<SocialRoute ports={ports}/>:<p>Elsewhere</p>}</DraftsProvider>;
 const r=render(<Shell show/>);await waitFor(()=>expect(screen.getByText('New post')).toBeTruthy());fireEvent.click(screen.getByText('New post'));fireEvent.change(screen.getByLabelText('Post text'),{target:{value:'Small teams deserve quiet evenings.'}});
 r.rerender(<Shell show={false}/>);r.rerender(<Shell show/>);expect((screen.getByLabelText('Post text') as HTMLTextAreaElement).value).toBe('Small teams deserve quiet evenings.');
 fireEvent.click(screen.getByText('Save draft'));await waitFor(()=>expect(mutate).toHaveBeenCalledTimes(1));expect(mutate.mock.calls[0]?.[0]).toMatchObject({action:'save',text:'Small teams deserve quiet evenings.',publishAt:null});
});
it('shows an unresolved delivery honestly and asks for cancellation before editing a native schedule',async()=>{
 const post={postId:'22222222-2222-4222-8222-222222222222',revision:1,accountId:account.id,text:'Already on the platform',images:[],publishAt:'2026-10-10T12:00:00Z',zone:'America/New_York',state:'scheduled' as const,reason:null};const mutate=vi.fn(async(_input:Parameters<SocialPorts['mutate']>[0])=>({accepted:true,view:{accounts:[account],posts:[{...post,state:'cancellation_pending' as const}]},reason:null}));
 render(<DraftsProvider><SocialRoute ports={{read:async()=>({view:{accounts:[account],posts:[post]},reason:null}),mutate}}/></DraftsProvider>);
 fireEvent.click(screen.getByText('Calendar'));await waitFor(()=>expect(screen.getByText('Already on the platform')).toBeTruthy());expect(screen.getByText('Scheduled on platform')).toBeTruthy();fireEvent.click(screen.getByText('Cancel schedule'));await waitFor(()=>expect(screen.getByText('Cancellation pending')).toBeTruthy());
});
it('shows the exact destination and approved image versions before approval',async()=>{
 const post={postId:'22222222-2222-4222-8222-222222222222',revision:2,accountId:account.id,text:'Review this exact version',images:[{assetId:'33333333-3333-4333-8333-333333333333',version:3,altText:'Callie maintenance dashboard'}],publishAt:'2026-10-10T12:00:00Z',zone:'America/New_York',state:'draft' as const,reason:null};
 render(<DraftsProvider><SocialRoute ports={{read:async()=>({view:{accounts:[account],posts:[post]},reason:null}),mutate:vi.fn()}}/></DraftsProvider>);
 await waitFor(()=>expect(screen.getByText('David Cui · linkedin · profile')).toBeTruthy());
 expect(screen.getByText('Callie maintenance dashboard · image version 3')).toBeTruthy();
 expect((screen.getByText('Approve & schedule') as HTMLButtonElement).disabled).toBe(true);
});
it('enables image approval only after the exact preview loads',async()=>{
 vi.stubGlobal('callieApi',{read:async()=>({preview:'data:image/png;base64,iVBORw0KGgo=',reason:null})});
 try{
 const post={postId:'22222222-2222-4222-8222-222222222222',revision:2,accountId:account.id,text:'Image approval',images:[{assetId:'33333333-3333-4333-8333-333333333333',version:3,altText:'Reviewed dashboard'}],publishAt:'2099-10-10T12:00:00Z',zone:'America/New_York',state:'draft' as const,reason:null};
 render(<DraftsProvider><SocialRoute ports={{read:async()=>({view:{accounts:[account],posts:[post]},reason:null}),mutate:vi.fn()}}/></DraftsProvider>);
 const image=await screen.findByAltText('Reviewed dashboard');expect((screen.getByText('Approve & schedule') as HTMLButtonElement).disabled).toBe(true);
 fireEvent.load(image);expect((screen.getByText('Approve & schedule') as HTMLButtonElement).disabled).toBe(false);
 }finally{vi.unstubAllGlobals();}
});
it('opens a generated variant directly in the editor without hiding it below the batch list',async()=>{
 vi.stubGlobal('callieApi',{read:async()=>({view:{sources:[],facts:[],requests:[{id:account.id,state:'ready',sourceRefs:[{kind:'public',id:account.id,revision:1}],factBlocks:[],reason:null,createdAt:'2026-10-01T12:00:00Z',deadlineAt:'2026-10-01T12:30:00Z',concepts:[{theme:'after_hours',factRefs:[],variants:[{platform:'linkedin',text:'Review before posting.'},{platform:'facebook',text:'Another variant.'},{platform:'x',text:'Short variant.'}]}]}]},reason:null})});
 try{const mutate=vi.fn();render(<DraftsProvider><SocialRoute ports={{read:async()=>({view:{accounts:[account],posts:[]},reason:null}),mutate}}/></DraftsProvider>);
 fireEvent.click(await screen.findByRole('button',{name:'Use LinkedIn draft'}));
 expect((screen.getByLabelText('Post text') as HTMLTextAreaElement).value).toBe('Review before posting.');expect((screen.getByLabelText('Publish time') as HTMLInputElement).value).toBe('');
 expect(screen.queryByLabelText('Draft ideas')).toBeNull();expect(mutate).not.toHaveBeenCalled();
 }finally{vi.unstubAllGlobals();}
});
it('shows missed-time recovery independently while retaining a successful sibling and refusing unknown replacement',async()=>{
 const base={postId:'22222222-2222-4222-8222-222222222222',revision:1,accountId:account.id,text:'Missed LinkedIn post',images:[],publishAt:'2026-10-08T12:00:00Z',zone:'America/New_York',state:'failed' as const,reason:'schedule_missed'};
 const posts=[base,{...base,postId:'33333333-3333-4333-8333-333333333333',text:'Successful sibling',state:'scheduled' as const,reason:null},{...base,postId:'44444444-4444-4444-8444-444444444444',text:'Unknown sibling',state:'unknown' as const,reason:'inspection_incomplete'}];
 const mutate=vi.fn();render(<DraftsProvider><SocialRoute ports={{read:async()=>({view:{accounts:[account],posts},reason:null}),mutate}}/></DraftsProvider>);
 expect(await screen.findByText('This time was missed. Choose a new time and approve the revised post.')).toBeTruthy();
 fireEvent.click(screen.getByText('Calendar'));
 expect(screen.getByText('Scheduled on platform')).toBeTruthy();
 expect(screen.getByText('Platform acceptance is uncertain. Check the original submission before replacing or posting manually.')).toBeTruthy();
 expect(screen.getAllByRole('button',{name:'Edit'})).toHaveLength(1);
 expect(mutate).not.toHaveBeenCalled();
});
