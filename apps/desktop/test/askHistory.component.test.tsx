// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Ask,type AskPorts} from '../src/renderer/ask/Ask.tsx';
afterEach(cleanup);
const requestId='11111111-1111-4111-8111-111111111111';
const historyList=vi.fn(async()=>({items:[{requestId,historyRevision:2,requestVersion:1,createdAt:'2026-10-09T11:00:00.000Z',updatedAt:'2026-10-09T11:01:00.000Z',title:'Scheduling investigation',pinned:true,question:'What matters to Alex?',state:'complete' as const,reason:null}],nextCursor:null}));
const read:AskPorts['read']=async()=>{throw new Error('not requested');};
it('lists dated private investigations inside Ask using the current authorized history read',async()=>{
 render(<Ask ports={{read,...{historyList}}} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 expect(await screen.findByText('Scheduling investigation')).toBeTruthy();
 expect(screen.getByText('What matters to Alex?')).toBeTruthy();
 expect(screen.getByText('Complete · Pinned')).toBeTruthy();
 expect(screen.getByText('2026-10-09T11:00:00.000Z').getAttribute('datetime')).toBe('2026-10-09T11:00:00.000Z');
 expect(historyList).toHaveBeenCalledWith({limit:20});
 expect(screen.getByRole('region',{name:'Private Ask history'})).toBeTruthy();
});

it('renders source-unavailable saved rows neutrally without private titles or questions',async()=>{
 const list=async()=>({items:[{requestId,historyRevision:3,requestVersion:2,createdAt:'2026-10-09T11:00:00.000Z',updatedAt:'2026-10-09T12:00:00.000Z',title:null,pinned:false,question:null,state:'stale' as const,reason:'source_changed' as const}],nextCursor:null});
 render(<Ask ports={{read,historyList:list}} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 expect(await screen.findByText('Unavailable investigation')).toBeTruthy();
 expect(screen.getByText('Stale')).toBeTruthy();
 expect(screen.queryByText('Scheduling investigation')).toBeNull();
 expect(screen.queryByText('What matters to Alex?')).toBeNull();
});
it('erases a protected history list when a subsequent current read is refused',async()=>{
 const list=vi.fn(async()=>await historyList()).mockResolvedValueOnce(await historyList()).mockRejectedValueOnce(new Error('source_unavailable'));
 render(<Ask ports={{read,historyList:list}} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 expect(await screen.findByText('Scheduling investigation')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 expect(await screen.findByText('Private history is unavailable. Read current access again.')).toBeTruthy();
 expect(screen.queryByText('Scheduling investigation')).toBeNull();
 expect(screen.queryByText('What matters to Alex?')).toBeNull();
});
it('discards a late private history response after the owner session changes',async()=>{
 let finish!:(value:Awaited<ReturnType<typeof historyList>>)=>void;
 const list=()=>new Promise<Awaited<ReturnType<typeof historyList>>>(resolve=>{finish=resolve;});
 const ports={read,historyList:list};
 const view=render(<Ask ports={ports} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 view.rerender(<Ask ports={ports} privacyKey='other:2' enabled/>);
 finish(await historyList());
 expect(screen.queryByText('Scheduling investigation')).toBeNull();
});

it('reopens saved history through a fresh answer read without requesting new inference',async()=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn<NonNullable<AskPorts['answerRead']>>(async()=>({requestId,version:1,createdAt:'2026-10-09T11:00:00.000Z',state:'complete',reason:null,question:'What matters to Alex?',fallback:null,answer:{answeredAt:'2026-10-09T11:01:00.000Z',claims:[{text:'Scheduling is the supported concern.',kind:'extractive',citationWindowIds:['22222222-2222-4222-8222-222222222222'],verification:'supported'}],conflicts:[],missingEvidence:[],abstained:false,coverage:{acquisition:'unverified',semantic:'bounded_evaluated',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:'a'.repeat(64)}}}));
 render(<Ask ports={{read,historyList,answerRead,answerRequest}} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 fireEvent.click(await screen.findByRole('button',{name:'Open investigation'}));
 expect(await screen.findByText('Scheduling is the supported concern.')).toBeTruthy();
 expect(answerRead).toHaveBeenCalledWith({requestId});
 expect(answerRequest).not.toHaveBeenCalled();
 expect(screen.queryByRole('button',{name:'Explain selected copies'})).toBeNull();
});

it('evicts old private history metadata when reopening discovers changed source evidence',async()=>{
 const answerRead=vi.fn<NonNullable<AskPorts['answerRead']>>(async()=>({requestId,version:2,createdAt:'2026-10-09T11:00:00.000Z',state:'stale',reason:'source_changed',question:null,fallback:null,answer:null}));
 render(<Ask ports={{read,historyList,answerRead}} privacyKey='owner:1' enabled/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private history'}));
 fireEvent.click(await screen.findByRole('button',{name:'Open investigation'}));
 expect(await screen.findByText('This explanation is stale. Select current source versions again.')).toBeTruthy();
 expect(screen.queryByText('Scheduling investigation')).toBeNull();
 expect(screen.queryByText('What matters to Alex?')).toBeNull();
});
