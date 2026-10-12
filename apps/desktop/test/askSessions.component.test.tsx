// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Ask,type AskPorts} from '../src/renderer/ask/Ask.tsx';
afterEach(cleanup);
const sessionId='11111111-1111-4111-8111-111111111111';
it('opens a private conversation, sends a follow-up through its version and starts a separate new conversation',async()=>{
 let version=1;
 const sessionCreate=vi.fn(async()=>({sessionId,version:1}));
 const sessionRead=vi.fn(async()=>({sessionId,version,scope:{kind:'business' as const},title:null,pinned:false,state:'active' as const,createdAt:'2026-10-10T12:00:00.000Z',turns:[],coverage:'current' as const}));
 const sessionTurn=vi.fn(async()=>({sessionId,version:++version,requestId:'22222222-2222-4222-8222-222222222222',requestVersion:1,state:'unavailable' as const}));
 const ports:AskPorts={read:async()=>{throw Error('unused');},sessionCreate,sessionRead,sessionTurn};
 render(<Ask ports={ports} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'New conversation'}));
 expect(await screen.findByText('Scope: approved business history')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Ask a question'),{target:{value:'What changed?'}});
 fireEvent.click(screen.getByRole('button',{name:'Ask question'}));
 await screen.findByText('Question saved. Processing may require configuration.');
 expect(sessionRead).toHaveBeenCalledWith({sessionId,includeExactResultCitations:true});
 expect(sessionTurn).toHaveBeenCalledWith({sessionId,version:1,question:'What changed?'});
 fireEvent.click(screen.getByRole('button',{name:'New conversation'}));
 await screen.findByText('Scope: approved business history');expect(sessionCreate).toHaveBeenCalledTimes(2);
});
it('previews an explicit session date range before confirming a version-bound change',async()=>{
 const sessionChange=vi.fn(async()=>({sessionId,version:2}));
 const ports:AskPorts={read:async()=>{throw Error('unused');},sessionCreate:async()=>({sessionId,version:1}),sessionRead:async()=>({sessionId,version:1,scope:{kind:'business'},title:null,pinned:false,state:'active',createdAt:'2026-10-10T12:00:00.000Z',turns:[],coverage:'current'}),sessionChange};
 render(<Ask ports={ports} privacyKey='owner:1' enabled/>);fireEvent.click(screen.getByRole('button',{name:'New conversation'}));
 fireEvent.change(await screen.findByLabelText('Conversation from date (UTC)'),{target:{value:'2026-10-01'}});
 fireEvent.change(screen.getByLabelText('Conversation until date (UTC)'),{target:{value:'2026-10-10'}});
 fireEvent.click(screen.getByRole('button',{name:'Preview conversation date range'}));expect(sessionChange).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Confirm conversation date range'}));
 await screen.findByText('Scope: approved business history');
 expect(sessionChange).toHaveBeenCalledWith({sessionId,version:1,action:{kind:'scope',scope:{kind:'business',from:'2026-10-01T00:00:00.000Z',to:'2026-10-11T00:00:00.000Z'},confirmExpansion:true}});
});

it('reads conversation history with mixed evidence enabled and reopens the same session',async()=>{
 const session={sessionId,version:1,scope:{kind:'business' as const},title:'Pilot comparison',pinned:false,state:'active' as const,createdAt:'2026-10-10T12:00:00.000Z',turns:[],coverage:'current' as const};
 const sessionList=vi.fn(async()=>({sessions:[session],nextAfter:null,truncated:false}));
 const sessionRead=vi.fn(async()=>session);
 render(<Ask ports={{read:async()=>{throw Error('unused');},sessionCreate:async()=>({sessionId,version:1}),sessionList,sessionRead}} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read conversations'}));
 fireEvent.click(await screen.findByRole('button',{name:/Pilot comparison/}));
 await screen.findByText('Scope: approved business history');
 expect(sessionList).toHaveBeenCalledWith({limit:20,includeExactResultCitations:true});
 expect(sessionRead).toHaveBeenCalledWith({sessionId,includeExactResultCitations:true});
});
