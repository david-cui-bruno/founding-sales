// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {ReplyComposer,type ReplyComposerPorts} from '../src/renderer/replies/ReplyComposer.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {ReplyDraftContext} from '../../../packages/contracts/src/replyComposer.ts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const ref={id,version:1};
const context:ReplyDraftContext={messageId:id,sourceRevision:'a'.repeat(64),firmId:id,contactId:id,authorUserId:id,mailboxId:id,mailboxOwnerUserId:id,authorAddress:'owner@example.test',authorizationRevision:1,subject:'Question',senderAddress:'prospect@example.test',providerThreadId:'thread-one',inReplyTo:'question@example.test',references:['question@example.test'],observedTo:['owner@example.test'],observedCc:[],replyToMetadata:'unavailable',envelope:{to:['prospect@example.test'],cc:[]},recipientOptions:[{address:'prospect@example.test',contactId:id}],messageText:'What does Callie do?',priorContext:[],facts:[{...ref,kind:'product',text:'Callie helps coordinate maintenance requests.',approvedAt:'2026-10-08T00:00:00Z',retiredAt:null}],availableFacts:[{...ref,kind:'product',text:'Callie helps coordinate maintenance requests.',approvedAt:'2026-10-08T00:00:00Z',retiredAt:null}]};
const ports=():ReplyComposerPorts=>({context:vi.fn<ReplyComposerPorts['context']>(async()=>({ok:true,value:context})),generate:vi.fn<ReplyComposerPorts['generate']>(async()=>({ok:false,reason:'generation_unavailable'}))});

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
 expect(p.generate).not.toHaveBeenCalled();
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
 const p=ports();p.generate=vi.fn<ReplyComposerPorts['generate']>(()=>new Promise(resolve=>{finish=resolve;}));
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
 await waitFor(()=>expect(p.generate).toHaveBeenCalledWith(expect.objectContaining({envelope:{to:['prospect@example.test'],cc:[extra]}})));
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
 await waitFor(()=>expect(p.generate).toHaveBeenCalledWith(expect.objectContaining({factRefs:[]})));
});
