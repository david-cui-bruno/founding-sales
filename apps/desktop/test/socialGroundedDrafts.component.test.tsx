// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {useState} from 'react';
import type {SaveAnswerBlock} from '@fss/contracts';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {SocialDraftStudio} from '../src/renderer/social/DraftStudio.tsx';
import {ApprovedFactsEditor} from '../src/renderer/outreach/ApprovedFactsEditor.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
afterEach(cleanup);

it('keeps untagged facts selectable in legacy mode while excluding tagged news from the request',async()=>{
 const plain={id:'00000000-0000-4000-8000-000000000003',version:1,text:'Bounded maintenance intake.'},tagged={id:'00000000-0000-4000-8000-000000000004',version:1,text:'An original engineering news claim.',socialInput:{topic:'news' as const,status:'observation' as const,sanitized:true as const}};
 const source={kind:'public' as const,id:'00000000-0000-4000-8000-000000000005',revision:1,label:'Public maintenance source',observedAt:'2026-10-13T10:00:00Z'},request=vi.fn(async()=>({requestId:'00000000-0000-4000-8000-000000000006',reason:null}));
 render(<DraftsProvider><SocialDraftStudio onUse={vi.fn()} ports={{read:async()=>({view:{sources:[source],facts:[plain,tagged],requests:[]},reason:null}),request}}/></DraftsProvider>);
 await screen.findByText(plain.text);expect(screen.queryByText(tagged.text)).toBeNull();
 fireEvent.click(screen.getByLabelText(/Public maintenance source/));fireEvent.click(screen.getByLabelText(plain.text));fireEvent.click(screen.getByRole('button',{name:'Generate drafts'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith({commandId:expect.any(String),sourceRefs:[{kind:'public',id:source.id,revision:1}],factBlocks:[{id:plain.id,version:1}]}));
});

it('selects an approved planned build input for LinkedIn only without selecting private sources',async()=>{
 const fact={id:'00000000-0000-4000-8000-000000000001',version:2,text:'Planning a bounded maintenance intake worker.',socialInput:{topic:'build' as const,status:'planned' as const,sanitized:true as const}};
 const request=vi.fn(async()=>({requestId:'00000000-0000-4000-8000-000000000002',reason:null}));
 render(<DraftsProvider><SocialDraftStudio onUse={vi.fn()} ports={{read:async()=>({view:{sources:[],facts:[fact],requests:[]},reason:null}),request}}/></DraftsProvider>);
 await screen.findByRole('button',{name:'Generate drafts'});
 expect(screen.queryByText(fact.text)).toBeNull();
 fireEvent.click(screen.getByLabelText('LinkedIn grounded draft'));
 await screen.findByText(fact.text);
 fireEvent.click(screen.getByLabelText(/Planning a bounded maintenance intake worker/));
 expect(screen.getByText(/planned · version 2/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Generate drafts'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.objectContaining({mode:'linkedin_grounded',sourceRefs:[],factBlocks:[{id:fact.id,version:2}]})));
});

it('keeps sanitized planned-versus-shipped scope in the normal governed fact save command',()=>{
 const mutate=vi.fn();
 function Editor(){const [draft,onChange]=useState<SaveAnswerBlock>({kind:'product',text:'Actual bounded worker work.'});return <ApprovedFactsEditor blocks={[]} draft={draft} blocked={false} refreshRequired={false} onChange={onChange} onBegin={onChange} onAdopt={vi.fn()} onMutate={mutate}/>;}
 render(<Editor/>);
 fireEvent.click(screen.getByLabelText('Sanitized LinkedIn factual input'));
 fireEvent.change(screen.getByLabelText('Work status'),{target:{value:'shipped'}});
 fireEvent.change(screen.getByLabelText('LinkedIn topic'),{target:{value:'technical'}});
 fireEvent.click(screen.getByRole('button',{name:'Save fact draft'}));
 expect(mutate).toHaveBeenCalledWith(expect.objectContaining({action:'fact_save',text:'Actual bounded worker work.',socialInput:{topic:'technical',status:'shipped',sanitized:true}}));
});

it('shows original spaced text and exact factual provenance without approving or publishing it',async()=>{
 const id='00000000-0000-4000-8000-000000000001',ref={id,version:2},onUse=vi.fn(),text='Actual owner work.\n\nA developed middle with concrete detail.\n\nStill a reviewable draft.';
 render(<DraftsProvider><SocialDraftStudio onUse={onUse} ports={{request:vi.fn(),read:async()=>({reason:null,view:{sources:[],facts:[{...ref,text:'Actual owner work.',socialInput:{topic:'technical',status:'local',sanitized:true}}],requests:[{id,mode:'linkedin_grounded',state:'ready',factBlocks:[ref],sourceRefs:[],concepts:[{theme:'technical',factRefs:[ref],variants:[{platform:'linkedin',text}]}],reason:null,createdAt:'2026-10-13T10:00:00Z',deadlineAt:'2026-10-13T10:30:00Z'}]}})}}/></DraftsProvider>);
 const use=await screen.findByRole('button',{name:'Use LinkedIn draft'});fireEvent.click(use);
 expect(onUse).toHaveBeenCalledWith({platform:'linkedin',text});
 expect(screen.getByLabelText('Sources for these facts').textContent).toContain('version 2 · local');
 expect(screen.getByText(/References preserve provenance, not proof/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Use Facebook draft'})).toBeNull();
});
