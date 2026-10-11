// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AskAnswer,type AskAnswerPorts} from '../src/renderer/ask/AskAnswer.tsx';
afterEach(cleanup);
const requestId='11111111-1111-4111-8111-111111111111';
it('cancels the current version without resubmitting or implying refunded dispatch',async()=>{
 let cancelled=false;
 const answerRead=vi.fn<AskAnswerPorts['answerRead']>(async()=>({requestId,version:1,createdAt:'2026-10-10T12:00:00.000Z',execution:'agent_v1',state:cancelled?'unavailable':'pending',reason:cancelled?'processing_cancelled':null,question:'What changed?',answer:null,fallback:null,progress:{completedSteps:2,stage:cancelled?'cancelled':'calling',cancelledAt:cancelled?'2026-10-10T12:01:00.000Z':null}}));
 const answerCancel=vi.fn(async()=>{cancelled=true;return {requestId,version:1,outcome:'cancelled' as const};});
 render(<AskAnswer ports={{answerRead,answerCancel}} enabled existingRequestId={requestId}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Cancel investigation'}));
 await screen.findByText(/already dispatched calls still settle/u);
 expect(answerCancel).toHaveBeenCalledWith({requestId,expectedVersion:1});
});
it('requires a dated allowance preview and separate human confirmation before new investigation',async()=>{
 const answerRead=vi.fn<AskAnswerPorts['answerRead']>(async()=>({requestId,version:1,createdAt:'2026-10-10T12:00:00.000Z',execution:'agent_v1',state:'unavailable',reason:'processing_failed',question:'What changed?',answer:null,fallback:null}));
 const investigationPreview=vi.fn(async()=>({available:true,reason:null,previewHash:'a'.repeat(64),scope:{kind:'business' as const},question:'What changed?',additionalAllowance:{maxSteps:4,maxInputBytes:10000,maxOutputTokens:500,deadlineMs:10000,ceilingCents:8}}));
 const investigationCommit=vi.fn(async()=>({requestId,version:1,state:'unavailable' as const}));
 render(<AskAnswer ports={{answerRead,investigationPreview,investigationCommit}} enabled existingRequestId={requestId}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Preview retry'}));
 await screen.findByText(/Configured ceiling: 8 cents/u);expect(investigationCommit).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Confirm new investigation'}));
 await waitFor(()=>expect(investigationCommit).toHaveBeenCalledWith({requestId,expectedVersion:1,mode:'retry',previewHash:'a'.repeat(64)}));
});
