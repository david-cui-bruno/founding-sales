// @vitest-environment jsdom
import {createRef} from 'react';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {RepliesRoute} from '../src/renderer/replies/RepliesRoute.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import {replyCard,replyState,replyWire,MESSAGE_ID} from './e2e/support/replyFixtures.ts';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('offers the source-bound human editor inside the open reply panel and typing performs no command',async()=>{
 const read=vi.fn(async(operation:string)=>operation==='replyComposer.context'?{ok:false,reason:'generation_unavailable'}:replyWire(replyState({open:replyCard()})));
 const command=vi.fn();vi.stubGlobal('callieApi',{read,command});
 render(<DraftsProvider><RepliesRoute column={createRef<HTMLElement>()} messageId={MESSAGE_ID}/></DraftsProvider>);
 const draft=await within(await screen.findByTestId('reply-card')).findByLabelText('Reply draft');
 fireEvent.change(draft,{target:{value:'A human answer.'}});
 expect(read).toHaveBeenCalledWith('replyComposer.context',{messageId:MESSAGE_ID});
 expect(command).not.toHaveBeenCalled();
 expect((screen.getByRole('button',{name:'Send reviewed reply'}) as HTMLButtonElement).disabled).toBe(true);
});
