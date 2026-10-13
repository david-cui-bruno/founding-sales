// @vitest-environment jsdom
import {it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {SocialDraftStudio} from '../src/renderer/social/DraftStudio.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';

it('selects an approved planned build input for LinkedIn only without selecting private sources',async()=>{
 const fact={id:'00000000-0000-4000-8000-000000000001',version:2,text:'Planning a bounded maintenance intake worker.',socialInput:{topic:'build' as const,status:'planned' as const,sanitized:true as const}};
 const request=vi.fn(async()=>({requestId:'00000000-0000-4000-8000-000000000002',reason:null}));
 render(<DraftsProvider><SocialDraftStudio onUse={vi.fn()} ports={{read:async()=>({view:{sources:[],facts:[fact],requests:[]},reason:null}),request}}/></DraftsProvider>);
 await screen.findByText(fact.text);
 fireEvent.click(screen.getByLabelText('LinkedIn grounded draft'));
 fireEvent.click(screen.getByLabelText(/Planning a bounded maintenance intake worker/));
 expect(screen.getByText(/planned · version 2/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Generate drafts'}));
 await waitFor(()=>expect(request).toHaveBeenCalledWith(expect.objectContaining({mode:'linkedin_grounded',sourceRefs:[],factBlocks:[{id:fact.id,version:2}]})));
});
