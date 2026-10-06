// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {SocialDraftStudio,type DraftStudioPorts} from '../src/renderer/social/DraftStudio.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {SocialDraftWorkspace} from '@fss/contracts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const view:SocialDraftWorkspace={sources:[{kind:'public',id,revision:2,label:'Example PM',observedAt:'2026-10-01T12:00:00Z'}],facts:[],requests:[]};
it('selects exact sources, retries the same request and never approves a post',async()=>{
 const request=vi.fn<DraftStudioPorts['request']>().mockResolvedValueOnce({requestId:null,reason:'offline'}).mockResolvedValueOnce({requestId:id,reason:null});
 const ports:DraftStudioPorts={read:async()=>({view,reason:null}),request};
 const use=vi.fn();render(<DraftsProvider><SocialDraftStudio ports={ports} onUse={use}/></DraftsProvider>);
 fireEvent.click(await screen.findByLabelText(/Example PM/));fireEvent.click(screen.getByText('Generate drafts'));
 await screen.findByText('Retry request');fireEvent.click(screen.getByText('Retry request'));
 await waitFor(()=>expect(request).toHaveBeenCalledTimes(2));expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);expect(request.mock.calls[0]![0]).toMatchObject({sourceRefs:[{kind:'public',id,revision:2}],factBlocks:[]});expect(use).not.toHaveBeenCalled();
});
it('shows platform variants and copies only the chosen text into an unscheduled editor',async()=>{
 const ready:SocialDraftWorkspace={...view,requests:[{id,state:'ready',sourceRefs:[{kind:'public',id,revision:2}],factBlocks:[],reason:null,createdAt:'2026-10-01T12:00:00Z',deadlineAt:'2026-10-01T12:30:00Z',concepts:[{theme:'after_hours',factRefs:[],variants:[{platform:'linkedin',text:'A quiet evening.'},{platform:'facebook',text:'Who answers after hours?'},{platform:'x',text:'Small teams, busy evenings.'}]}]}]};
 const use=vi.fn();render(<DraftsProvider><SocialDraftStudio ports={{read:async()=>({view:ready,reason:null}),request:vi.fn()}} onUse={use}/></DraftsProvider>);
 await screen.findByText('A quiet evening.');fireEvent.click(screen.getByRole('button',{name:'Use LinkedIn draft'}));expect(use).toHaveBeenCalledWith({platform:'linkedin',text:'A quiet evening.'});
});
it('keeps selected sources across navigation',async()=>{
 const ports:DraftStudioPorts={read:async()=>({view,reason:null}),request:vi.fn()};
 const Shell=({show}:{show:boolean})=><DraftsProvider>{show?<SocialDraftStudio ports={ports} onUse={()=>{}}/>:null}</DraftsProvider>;
 const r=render(<Shell show/>);fireEvent.click(await screen.findByLabelText(/Example PM/));r.rerender(<Shell show={false}/>);r.rerender(<Shell show/>);
 expect((await screen.findByLabelText(/Example PM/) as HTMLInputElement).checked).toBe(true);
});
