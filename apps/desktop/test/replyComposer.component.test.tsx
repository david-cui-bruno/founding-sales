// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ReplyComposer,type ReplyComposerPorts} from '../src/renderer/replies/ReplyComposer.tsx';
import {DraftsProvider,useClearDrafts} from '../src/renderer/app/drafts.tsx';
import type {ReplyDraftContext} from '../../../packages/contracts/src/replyComposer.ts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const ref={id,version:1};
const context:ReplyDraftContext={messageId:id,sourceRevision:'a'.repeat(64),firmId:id,contactId:id,authorUserId:id,mailboxId:id,mailboxOwnerUserId:id,authorAddress:'owner@example.test',authorizationRevision:1,subject:'Question',senderAddress:'prospect@example.test',providerThreadId:'thread-one',inReplyTo:'question@example.test',references:['question@example.test'],observedTo:['owner@example.test'],observedCc:[],replyToMetadata:'unavailable',envelope:{to:['prospect@example.test'],cc:[]},recipientOptions:[{address:'prospect@example.test',contactId:id}],messageText:'What does Callie do?',priorContext:[],bookings:[],facts:[{...ref,kind:'product',text:'Callie helps coordinate maintenance requests.',approvedAt:'2026-10-08T00:00:00Z',retiredAt:null}],availableFacts:[{...ref,kind:'product',text:'Callie helps coordinate maintenance requests.',approvedAt:'2026-10-08T00:00:00Z',retiredAt:null}]};
const ports=():ReplyComposerPorts=>({context:vi.fn<ReplyComposerPorts['context']>(async()=>({ok:true,value:context})),prepareSuggestion:vi.fn<ReplyComposerPorts['prepareSuggestion']>(async()=>({ok:false,reason:'generation_unavailable'}))});

it('shows final bytes before enabling one explicit send and keeps uncertainty on the original attempt through navigation',async()=>{
 const p=ports(),sent={messageId:id,outboundMessageId:id,state:'reconciling' as const,providerMessageId:null,sentAt:null,reason:null};
 p.preview=vi.fn(async input=>({ok:true as const,value:{sourceRevision:context.sourceRevision,draftRevision:'b'.repeat(64),subject:'Re: Question',body:input.text+'\n\nFixture postal address',envelope:input.envelope}}));
 const send=vi.fn(async()=>({ok:true as const,value:sent}));p.send=send;
 p.sendStatus=vi.fn(async()=>send.mock.calls.length?{ok:true as const,value:sent}:{ok:false as const,reason:'no_send_attempt'});
 const tree=(open:boolean)=><DraftsProvider>{open?<ReplyComposer messageId={id} ports={p}/>:<p>Today</p>}</DraftsProvider>;
 const view=render(tree(true));await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'My exact human answer.'}});
 expect((screen.getByRole('button',{name:'Send reviewed reply'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Review exact draft'}));
 expect(await screen.findByText(/Fixture postal address/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Send reviewed reply'}));
 fireEvent.click(screen.getByRole('button',{name:'Send reviewed reply'}));
 expect(await screen.findByText(/Delivery is uncertain/)).toBeTruthy();
 expect(p.send).toHaveBeenCalledTimes(1);
 expect(p.send).toHaveBeenCalledWith(expect.objectContaining({text:'My exact human answer.',draftRevision:'b'.repeat(64),envelope:context.envelope}));
 view.rerender(tree(false));view.rerender(tree(true));
 expect(await screen.findByText(/Delivery is uncertain/)).toBeTruthy();
 expect((screen.getByRole('button',{name:'Send reviewed reply'}) as HTMLButtonElement).disabled).toBe(true);
 expect(p.send).toHaveBeenCalledTimes(1);
});

it('retains human text across navigation and shows current recipient/thread/fact context without a send control',async()=>{
 const p=ports();
 const tree=(open:boolean)=><DraftsProvider>{open?<ReplyComposer messageId={id} ports={p}/>:<p>Today</p>}</DraftsProvider>;
 const view=render(tree(true));
 await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'My edited answer.'}});
 view.rerender(tree(false));view.rerender(tree(true));
 await waitFor(()=>expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('My edited answer.'));
 expect(screen.getByText(/Reply-To address metadata is unavailable/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:/send/i})).toBeNull();
 expect(p.prepareSuggestion).not.toHaveBeenCalled();
});

it('retains a human edit when refreshed source changes and requires explicit adoption before exact review',async()=>{
 let current=context;const p=ports();p.context=vi.fn<ReplyComposerPorts['context']>(async()=>({ok:true,value:current}));
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'My answer remains mine.'}});
 current={...context,sourceRevision:'b'.repeat(64),messageText:'A newer question.'};
 fireEvent.click(screen.getByRole('button',{name:'Refresh reply context'}));
 expect(await screen.findByText(/Your draft is stale/)).toBeTruthy();
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('My answer remains mine.');
 expect((screen.getByRole('button',{name:'Review exact draft'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Use current context'}));
 fireEvent.click(screen.getByRole('button',{name:'Review exact draft'}));
 expect(await screen.findByText('Reviewed exact draft. Editing it requires another review.')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'A changed promise.'}});
 expect(screen.queryByText('Reviewed exact draft. Editing it requires another review.')).toBeNull();
});

it('a late suggestion never replaces newer human typing and adoption remains explicit',async()=>{
 let finish!:(value:{ok:true;value:{sourceRevision:string;draftRevision:string;text:string;factRefs:typeof ref[];reviewRequired:true;reviewNotes:string[]}})=>void;
 const p=ports();p.prepareSuggestion=vi.fn<ReplyComposerPorts['prepareSuggestion']>(()=>new Promise(resolve=>{finish=resolve;}));
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 await screen.findByText('question@example.test');
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion'}));
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'My new typing wins.'}});
 finish({ok:true,value:{sourceRevision:context.sourceRevision,draftRevision:'c'.repeat(64),text:'A model suggestion.',factRefs:[ref],reviewRequired:true,reviewNotes:['Confirm missing commitments.']}});
 await screen.findByRole('button',{name:'Use suggestion'});
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('My new typing wins.');
 fireEvent.click(screen.getByRole('button',{name:'Use suggestion'}));
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('A model suggestion.');
 expect(screen.queryByText('Reviewed exact draft. Editing it requires another review.')).toBeNull();
});

it('an explicit CC choice is validated as a new draft envelope and invalidates review',async()=>{
 const extra='colleague@prospect.example.test',p=ports();
 p.context=vi.fn<ReplyComposerPorts['context']>(async input=>({ok:true,value:{...context,observedCc:[extra],recipientOptions:[...context.recipientOptions,{address:extra,contactId:id}],envelope:input.envelope??context.envelope,sourceRevision:input.envelope?.cc.includes(extra)?'b'.repeat(64):context.sourceRevision}}));
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'An answer for both people.'}});
 fireEvent.change(screen.getByLabelText(`${extra} recipient`),{target:{value:'cc'}});
 expect(await screen.findByText(/Your draft is stale/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Use current context'}));
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion'}));
 await waitFor(()=>expect(p.prepareSuggestion).toHaveBeenCalledWith(expect.objectContaining({envelope:{to:['prospect@example.test'],cc:[extra]}})));
 expect(screen.getByText(/CC dispatch is a separate feature/)).toBeTruthy();
});

it('retired facts keep human text stale while refresh exposes current approved choices for explicit adoption',async()=>{
 let retired=false;const p=ports();
 p.context=vi.fn<ReplyComposerPorts['context']>(async input=>retired&&input.factRefs?.some(f=>f.id===id)?{ok:false,reason:'block_retired'}:{ok:true,value:retired?{...context,sourceRevision:'b'.repeat(64),facts:[],availableFacts:[]}:context});
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'My draft with an old claim.'}});
 retired=true;fireEvent.click(screen.getByRole('button',{name:'Refresh reply context'}));
 expect(await screen.findByRole('button',{name:'Use current context'})).toBeTruthy();
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('My draft with an old claim.');
 fireEvent.click(screen.getByRole('button',{name:'Use current context'}));
 expect(screen.getByText('No approved facts selected. Unsupported claims and commitments require your review.')).toBeTruthy();
});

it('changing the selected exact approved facts retains text and requires a fresh context review',async()=>{
 const p=ports();p.context=vi.fn<ReplyComposerPorts['context']>(async input=>({ok:true,value:{...context,facts:input.factRefs?.length===0?[]:context.facts,sourceRevision:input.factRefs?.length===0?'b'.repeat(64):context.sourceRevision}}));
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'A human answer.'}});
 fireEvent.click(screen.getByRole('checkbox',{name:/Callie helps coordinate maintenance requests/}));
 expect(await screen.findByText(/Your draft is stale/)).toBeTruthy();
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('A human answer.');
 fireEvent.click(screen.getByRole('button',{name:'Use current context'}));
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion'}));
 await waitFor(()=>expect(p.prepareSuggestion).toHaveBeenCalledWith(expect.objectContaining({factRefs:[]})));
});

it('refreshing during generation drops its late result and leaves the retained draft editable',async()=>{
 let finish!:(value:Awaited<ReturnType<ReplyComposerPorts['prepareSuggestion']>>)=>void;
 const p=ports();p.prepareSuggestion=vi.fn<ReplyComposerPorts['prepareSuggestion']>(()=>new Promise(resolve=>{finish=resolve;}));
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'Keep my human answer.'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion'}));
 fireEvent.click(screen.getByRole('button',{name:'Refresh reply context'}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'Prepare suggestion'}) as HTMLButtonElement).disabled).toBe(false));
 finish({ok:true,value:{sourceRevision:context.sourceRevision,draftRevision:'c'.repeat(64),text:'An obsolete suggestion.',factRefs:[ref],reviewRequired:true,reviewNotes:['Review this.']}});
 await waitFor(()=>expect(p.context).toHaveBeenCalledTimes(2));
 expect(screen.queryByText('An obsolete suggestion.')).toBeNull();
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('Keep my human answer.');
});

it('explains an unknown suggestion result in plain language and reuses the same attempt after navigation',async()=>{
 const p=ports();p.prepareSuggestion=vi.fn<ReplyComposerPorts['prepareSuggestion']>(async()=>({ok:false,reason:'generation_outcome_unknown'}));
 const tree=(open:boolean)=><DraftsProvider>{open?<ReplyComposer messageId={id} ports={p}/>:<p>Today</p>}</DraftsProvider>;
 const view=render(tree(true));await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'Keep this answer.'}});
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion'}));
 expect(await screen.findByText(/No definite suggestion result is available/)).toBeTruthy();
 expect(screen.queryByText(/generation_outcome_unknown/)).toBeNull();
 const first=vi.mocked(p.prepareSuggestion).mock.calls[0]![0].commandId;
 view.rerender(tree(false));view.rerender(tree(true));await screen.findByText('question@example.test');
 fireEvent.click(screen.getByRole('button',{name:'Prepare suggestion'}));
 await waitFor(()=>expect(p.prepareSuggestion).toHaveBeenCalledTimes(2));
 expect(vi.mocked(p.prepareSuggestion).mock.calls[1]![0].commandId).toBe(first);
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('Keep this answer.');
});

it('shows current booking state beside the editable draft without appointment controls',async()=>{
 const p=ports();p.context=vi.fn<ReplyComposerPorts['context']>(async()=>({ok:true,value:{...context,bookings:[{id,state:'cancelled',startsAt:'2026-10-12T15:00:00.000Z',endsAt:'2026-10-12T15:30:00.000Z'}]}}));
 render(<DraftsProvider><ReplyComposer messageId={id} ports={p}/></DraftsProvider>);
 expect(await screen.findByText(/Meeting cancelled:/)).toBeTruthy();
 expect(screen.queryByRole('button',{name:/book|reschedule|cancel/i})).toBeNull();
});

it('separates human prose from classification cleanup and clears it when the signed-in identity changes',async()=>{
 const p=ports();function ClassificationCleanup(){const clear=useClearDrafts();return <button onClick={()=>clear(`replies:m:${id}:`)}>Finish classification</button>;}
 const tree=(identity:string)=><DraftsProvider key={identity}><ClassificationCleanup/><ReplyComposer messageId={id} ports={p}/></DraftsProvider>;
 const view=render(tree('first'));await screen.findByText('question@example.test');
 fireEvent.change(screen.getByLabelText('Reply draft'),{target:{value:'My own human prose.'}});
 fireEvent.click(screen.getByRole('button',{name:'Finish classification'}));
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('My own human prose.');
 view.rerender(tree('second'));await screen.findByText('question@example.test');
 expect((screen.getByLabelText('Reply draft') as HTMLTextAreaElement).value).toBe('');
});
