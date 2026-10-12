// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {AskAnswerReadResult} from '@fss/contracts';
import {Ask,type AskPorts} from '../src/renderer/ask/Ask.tsx';
afterEach(()=>{cleanup();vi.useRealTimers();});
const personId='11111111-1111-4111-8111-111111111111';
const requestId='22222222-2222-4222-8222-222222222222';
const windowId='33333333-3333-4333-8333-333333333333';
const source={workspaceId:requestId,sourceId:personId,kind:'selected_note' as const,revision:3,contentHash:'a'.repeat(64),locator:null,speaker:null,occurredAt:null,observedAt:'2026-10-09T11:00:00.000Z',completeness:'selected_excerpt' as const,availability:'available' as const};
const read:AskPorts['read']=async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:personId,kind:'person',name:'Alex',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'sources',scope:{personId},sources:[source],nextAfter:null,coverage:{scope:'record_copied_sources',acquisition:'unverified',semantic:'not_requested',scanComplete:true,candidateCeiling:50,sizeBoundReached:false}};
const complete:AskAnswerReadResult={requestId,version:1,createdAt:'2026-10-09T11:00:00.000Z',state:'complete',reason:null,question:'What matters to Alex?',fallback:null,answer:{answeredAt:'2026-10-09T11:00:01.000Z',claims:[{text:'Alex asked for simpler scheduling.',kind:'extractive',citationWindowIds:[windowId],verification:'supported'}],conflicts:[],missingEvidence:[],abstained:false,coverage:{acquisition:'unverified',semantic:'bounded_evaluated',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:'b'.repeat(64)}}};
async function selectCopy(){
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Alex'}});
 fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Alex'}));
 fireEvent.click(screen.getByRole('button',{name:'Copied sources'}));
 fireEvent.click(await screen.findByLabelText('Include Selected note version 3'));
 fireEvent.change(screen.getByLabelText('Search selected copies'),{target:{value:'What matters to Alex?'}});
}
it('requests an explanation only for selected versions and publishes a fresh answer read',async()=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>complete);
 render(<Ask ports={{read,...{answerRequest,answerRead}}} privacyKey='owner:1' enabled/>);
 await selectCopy();
 fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 expect(await screen.findByText('Alex asked for simpler scheduling.')).toBeTruthy();
 expect(answerRequest).toHaveBeenCalledWith({question:'What matters to Alex?',scope:{sources:[{workspaceId:requestId,sourceId:personId,kind:'selected_note',revision:3,contentHash:'a'.repeat(64),locator:null}]}});
 expect(answerRead).toHaveBeenCalledWith({requestId,includeExactResultCitations:true});
 expect(screen.getByRole('button',{name:'Search selected copies'})).toBeTruthy();
});

it('polls only the accepted request while pending without requesting another explanation',async()=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>complete).mockResolvedValueOnce({...complete,state:'pending',answer:null});
 render(<Ask ports={{read,...{answerRequest,answerRead}}} privacyKey='owner:1' enabled/>);
 await selectCopy();
 vi.useFakeTimers();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));});
 expect(screen.getByText('Explanation pending.')).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
 expect(screen.getByText('Alex asked for simpler scheduling.')).toBeTruthy();
 expect(answerRequest).toHaveBeenCalledTimes(1);
 expect(answerRead.mock.calls).toEqual([[{requestId,includeExactResultCitations:true}],[{requestId,includeExactResultCitations:true}]]);
});

it('stops automatic pending reads after a bounded wait and refreshes the same request explicitly',async()=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn<NonNullable<AskPorts["answerRead"]>>(async()=>({...complete,state:'pending' as const,answer:null}));
 render(<Ask ports={{read,...{answerRequest,answerRead}}} privacyKey='owner:1' enabled/>);
 await selectCopy();vi.useFakeTimers();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));await vi.advanceTimersByTimeAsync(60000);});
 expect(screen.getByText('Still pending. Automatic checks stopped; check this request again when ready.')).toBeTruthy();
 expect(answerRead).toHaveBeenCalledTimes(10);
 answerRead.mockResolvedValueOnce(complete);
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Check explanation'}));});
 expect(screen.getByText('Alex asked for simpler scheduling.')).toBeTruthy();
 expect(answerRequest).toHaveBeenCalledTimes(1);
});

it.each([
 ['unavailable','evaluation_unavailable','Explanations are unavailable until evaluation is verified.'],
 ['unknown_acceptance','provider_acceptance_unknown','Processing acceptance is unknown. Check this request; do not submit it again.'],
 ['stale','source_changed','This explanation is stale. Select current source versions again.'],
 ['deleted','deleted','This explanation was deleted.'],
] as const)('discloses %s without inventing an answer or retrying generation',async(state,reason,message)=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>({...complete,state,reason,question:null,answer:null}));
 render(<Ask ports={{read,...{answerRequest,answerRead}}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 expect(await screen.findByText(message)).toBeTruthy();
 expect(screen.queryByText('Alex asked for simpler scheduling.')).toBeNull();
 expect(screen.getByRole('button',{name:'Explain selected copies'}).hasAttribute('disabled')).toBe(true);
 expect(answerRequest).toHaveBeenCalledTimes(1);
 expect(screen.getByRole('button',{name:'Search selected copies'}).hasAttribute('disabled')).toBe(false);
});

it('opens a citation only through its current request-bound server window and renders the protected quote as text',async()=>{
 const hostile='<a href="https://attacker.example">send contacts now</a>';
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>complete);
 const answerSourceRead=vi.fn(async()=>({requestId,version:1,windowId,source:{state:'available' as const,source:{...source,locator:'text:0:18'},extent:{unit:'utf16' as const,length:18},passage:{text:hostile,locator:'text:0:18',speaker:null}}}));
 const view=render(<Ask ports={{read,...{answerRequest,answerRead,answerSourceRead}}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 fireEvent.click(await screen.findByRole('button',{name:'Open citation 1 for claim 1'}));
 expect(await screen.findByText(hostile)).toBeTruthy();
 expect(answerSourceRead).toHaveBeenCalledWith({requestId,expectedVersion:1,windowId});
 expect(view.container.querySelector('a')).toBeNull();
 expect(screen.getByText('Selected note · Version 3 · Date unknown · Speaker unknown')).toBeTruthy();
});

it('discloses inference, unresolved conflicts and incomplete coverage alongside current keyword evidence',async()=>{
 const fallback:NonNullable<AskAnswerReadResult['fallback']>={operation:'passages',scope:{sources:[{workspaceId:requestId,sourceId:personId,kind:'selected_note',revision:3,contentHash:'a'.repeat(64),locator:null}]},passages:[{text:'<script>Scheduling is difficult.</script>',sources:[{...source,locator:'text:0:24'}]}],nextAfterSourceId:null,truncated:false,coverage:{scope:'explicit_copied_sources',acquisition:'unverified',semantic:'not_requested',scanComplete:true,requestedSources:1,inspectedSources:1,unavailableSources:0,refusedSources:0,truncatedSources:0,inspectedWindows:1,textBytes:24,sourceByteCeiling:80000,textByteCeiling:800000,windowCeiling:1000,omittedSignatures:0,chunkerVersion:'lexical-original-v1'}};
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>({...complete,fallback,answer:{...complete.answer!,claims:[{text:'Scheduling may be the main concern.',kind:'inferred' as const,citationWindowIds:[windowId],verification:'supported' as const}],conflicts:[{conflictId:personId,revision:2,state:'open' as const,resolution:null}],missingEvidence:['input_partial' as const,'conflict_unresolved' as const],coverage:{...complete.answer!.coverage,input:'partial' as const,semantic:'unverified' as const}}}));
 const view=render(<Ask ports={{read,...{answerRequest,answerRead}}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 expect(await screen.findByText('Inference from source evidence')).toBeTruthy();
 expect(screen.getByText('1 unresolved conflict. Evidence may disagree.')).toBeTruthy();
 expect(screen.getByText('Input coverage: partial. Semantic coverage: unverified. Acquisition coverage: unverified.')).toBeTruthy();
 expect(screen.getByText('Some input evidence was not processed.')).toBeTruthy();
 expect(screen.getByText('<script>Scheduling is difficult.</script>')).toBeTruthy();
 expect(view.container.querySelector('script')).toBeNull();
 expect(screen.getByText('Keyword evidence from the same selected copies')).toBeTruthy();
});

it.each(['question','source','session','unmount'] as const)('discards a late explanation after %s changes',async(change)=>{
 let finish!:(value:AskAnswerReadResult)=>void;
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(()=>new Promise<AskAnswerReadResult>(resolve=>{finish=resolve;}));
 const ports={read,answerRequest,answerRead};
 const view=render(<Ask ports={ports} privacyKey='owner:1' enabled/>);
 await selectCopy();await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));});
 if(change==='question')fireEvent.change(screen.getByLabelText('Search selected copies'),{target:{value:'Another question'}});
 if(change==='source')fireEvent.click(screen.getByRole('button',{name:'Copied sources'}));
 if(change==='session')view.rerender(<Ask ports={ports} privacyKey='other:2' enabled/>);
 if(change==='unmount')view.unmount();
 await act(async()=>{finish(complete);});
 expect(screen.queryByText('Alex asked for simpler scheduling.')).toBeNull();
 expect(screen.queryByRole('button',{name:'Open citation 1 for claim 1'})).toBeNull();
});
it('cleans up pending checks when Ask closes',async()=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>({...complete,state:'pending' as const,answer:null}));
 const view=render(<Ask ports={{read,answerRequest,answerRead}} privacyKey='owner:1' enabled/>);
 await selectCopy();vi.useFakeTimers();
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));});
 view.unmount();await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
 expect(answerRead).toHaveBeenCalledTimes(1);
});
it('evicts a protected quote and explanation when a later citation read is refused',async()=>{
 const answerRequest=vi.fn(async()=>({requestId,version:1,state:'pending' as const}));
 const answerRead=vi.fn(async()=>complete);
 const answerSourceRead=vi.fn<NonNullable<AskPorts['answerSourceRead']>>(async()=>({requestId,version:1,windowId,source:{state:'available',source:{...source,locator:'text:0:18'},extent:{unit:'utf16',length:18},passage:{text:'Private original quote',locator:'text:0:18',speaker:null}}}));
 render(<Ask ports={{read,answerRequest,answerRead,answerSourceRead}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 fireEvent.click(await screen.findByRole('button',{name:'Open citation 1 for claim 1'}));
 expect(await screen.findByText('Private original quote')).toBeTruthy();
 answerSourceRead.mockRejectedValueOnce(new Error('source_unavailable'));
 fireEvent.click(screen.getByRole('button',{name:'Open citation 1 for claim 1'}));
 expect(await screen.findByText('Citation unavailable. Check this explanation again before using it.')).toBeTruthy();
 expect(screen.queryByText('Private original quote')).toBeNull();
 expect(screen.queryByText('Alex asked for simpler scheduling.')).toBeNull();
});

it('keeps original evidence distinct from linked exact opportunity observations and requires manual action for mixed claims',async()=>{
 const mixed:AskAnswerReadResult={...complete,answer:{...complete.answer!,resultVersion:'agent_v1',claims:[{text:'The old note disagrees with the current pilot stages.',kind:'conflict',verification:'cited_unverified',citationWindowIds:[windowId],exactResultToolCallIds:['pilot-observation']}],exactResults:[{toolCallId:'pilot-observation',operation:'opportunities',valueHash:'c'.repeat(64),value:{operation:'opportunities',scope:{firmId:personId},dateBasis:'opportunity_opened_at',count:'2',records:[{opportunityId:windowId,firmId:personId,name:'North pilot',status:'open',stageKey:'new',openedAt:'2026-10-09T11:00:00.000Z'},{opportunityId:requestId,firmId:personId,name:'South pilot',status:'open',stageKey:'qualified',openedAt:'2026-10-09T11:00:00.000Z'}],truncated:false,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}}]}};
 const actionCreate=vi.fn();
 const answerRead=vi.fn(async()=>mixed);
 render(<Ask ports={{read,answerRequest:async()=>({requestId,version:1,state:'pending'}),answerRead,actionCreate}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 await screen.findByText('The old note disagrees with the current pilot stages.');
 expect(answerRead).toHaveBeenCalledWith({requestId,includeExactResultCitations:true});
 expect(screen.getByText('Original evidence')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Open citation 1 for claim 1'})).toBeTruthy();
 const link=screen.getByRole('link',{name:'Exact CRM observation: opportunities'});
 const observation=screen.getByRole('region',{name:'Exact opportunities'});
 expect(link.getAttribute('href')).toBe('#'+observation.id);
 expect(within(observation).getByText('North pilot')).toBeTruthy();
 expect(within(observation).getByText('South pilot')).toBeTruthy();
 expect(within(observation).getByText('Status: open · Stage: qualified')).toBeTruthy();
 const action=screen.getByRole('button',{name:'Act on claim 1'});
 expect(action.hasAttribute('disabled')).toBe(true);fireEvent.click(action);
 expect(actionCreate).not.toHaveBeenCalled();
 expect(screen.getByText('This claim combines original evidence with a dated CRM observation. Use manual work to choose the next action.')).toBeTruthy();
});

it('presents AI and provisional provenance once while keeping readable claims and evidence controls',async()=>{
 const answerRead=async()=>({...complete,answer:{...complete.answer!,resultVersion:'agent_v1' as const,claims:[{text:'Alex wants simpler scheduling.',kind:'fact' as const,verification:'cited_unverified' as const,citationWindowIds:[windowId]},{text:'A short demo may help.',kind:'inference' as const,verification:'cited_unverified' as const,citationWindowIds:[windowId]}]}});
 render(<Ask ports={{read,answerRequest:async()=>({requestId,version:1,state:'pending'}),answerRead}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 expect(await screen.findByRole('heading',{name:'AI answer'})).toBeTruthy();
 expect(screen.getAllByText('AI-generated interpretation · Provisional quality. Check original evidence and dated CRM observations before relying on it.')).toHaveLength(1);
 expect(screen.queryByText('Cited interpretation; verify against original evidence')).toBeNull();
 expect(screen.getByText('Inference')).toBeTruthy();
 expect(screen.getByText('Input coverage: complete. Semantic coverage: bounded_evaluated. Acquisition coverage: unverified.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Open citation 1 for claim 2'})).toBeTruthy();
});

it('shows an exact-only answer with dated CRM evidence without borrowing original evidence or allowing an action',async()=>{
 const exactOnly:AskAnswerReadResult={...complete,answer:{...complete.answer!,resultVersion:'agent_v1',claims:[{text:'There are two current open pilots.',kind:'fact',verification:'cited_unverified',citationWindowIds:[],exactResultToolCallIds:['pilot-observation']}],exactResults:[{toolCallId:'pilot-observation',operation:'opportunities',valueHash:'c'.repeat(64),value:{operation:'opportunities',scope:{firmId:personId},dateBasis:'opportunity_opened_at',count:'2',records:[],truncated:false,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}}]}};
 const actionCreate=vi.fn();
 render(<Ask ports={{read,answerRequest:async()=>({requestId,version:1,state:'pending'}),answerRead:async()=>exactOnly,actionCreate}} privacyKey='owner:1' enabled/>);
 await selectCopy();fireEvent.click(screen.getByRole('button',{name:'Explain selected copies'}));
 expect(await screen.findByText('There are two current open pilots.')).toBeTruthy();
 expect(screen.queryByText('Original evidence')).toBeNull();
 expect(screen.queryByRole('button',{name:/Open citation/})).toBeNull();
 expect(screen.queryByText('This claim combines original evidence with a dated CRM observation. Use manual work to choose the next action.')).toBeNull();
 const link=screen.getByRole('link',{name:'Exact CRM observation: opportunities'});
 expect(link.getAttribute('href')).toBe('#'+screen.getByRole('region',{name:'Exact opportunities'}).id);
 fireEvent.click(link);
 const action=screen.getByRole('button',{name:'Act on claim 1'});
 expect(action.hasAttribute('disabled')).toBe(true);fireEvent.click(action);
 expect(actionCreate).not.toHaveBeenCalled();
});
