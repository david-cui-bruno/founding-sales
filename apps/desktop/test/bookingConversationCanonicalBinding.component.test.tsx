// @vitest-environment jsdom
import {cleanup,render,screen,act} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach,expect,it,vi} from 'vitest';
import type {BookingConversationView,BookingInterpretationView} from '@fss/contracts';
import {BookingConversation,type BookingConversationPorts} from '../src/renderer/firms/BookingConversation.tsx';
const original='11111111-1111-4111-8111-111111111111',selected='22222222-2222-4222-8222-222222222222';
const interpretation:BookingInterpretationView={requestId:selected,state:'complete',reason:null,outcome:{kind:'approved_link',bookingUrl:'https://cal.com/controlled/demo',schedulingPaused:false,permission:false},provenance:null,financial:null,limitations:[]};
const conversation:BookingConversationView={conversationId:original,interpretationRequestId:original,policyRevision:3,origin:'standing_policy',enabled:false,state:'unknown',reason:null,outcome:interpretation.outcome,handoff:{ownerUserId:original,action:'review_booking',evidence:{sourceId:original,start:0,end:6,quote:'secret'}},booking:null,change:null,nudgeCount:1,nudgesStoppedAt:null,lastReplyAt:null,explicitNoShowAt:null,noShowRebookingUsed:false,limitations:[]};
function ports(){return {policy:vi.fn(async()=>({revision:3,status:'saved' as const})),request:vi.fn(async()=>conversation),read:vi.fn(async()=>conversation),event:vi.fn(async()=>conversation),messageRequest:vi.fn(async()=>{throw Error('held');}),messageRead:vi.fn(async()=>{throw Error('held');})};}
afterEach(cleanup);
for(const changed of ['conversationId','interpretationRequestId','unavailable'] as const)it(`rejects ${changed} after canonical admission, clearing private outcomes without replay`,async()=>{
 const base=ports();render(<BookingConversation ports={base} interpretation={interpretation} privacyKey="owner" sourceVersion={1} enabled/>);
 const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));expect(await screen.findByText('secret')).toBeTruthy();
 expect(base.request).toHaveBeenCalledWith({interpretationRequestId:selected,expectedPolicyRevision:3});
 expect(screen.queryByRole('button',{name:'Record manual booking nudge'})).toBeNull();
 if(changed==='unavailable')base.read.mockRejectedValue(Error('unavailable'));else base.read.mockResolvedValue({...conversation,[changed]:selected});
 await user.click(screen.getByRole('button',{name:'Inspect current booking conversation'}));expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('secret')).toBeNull();expect(base.request).toHaveBeenCalledTimes(1);expect(base.event).not.toHaveBeenCalled();
 base.read.mockResolvedValue(conversation);await user.click(screen.getByRole('button',{name:'Inspect current booking conversation'}));expect(await screen.findByText('secret')).toBeTruthy();expect(base.request).toHaveBeenCalledTimes(1);
});
for(const scope of ['source','interpretation','privacy','enabled','ports'] as const)it(`clears canonical binding and ignores a late reused episode read after ${scope} scope changes`,async()=>{
 const base=ports();let resolve:(value:BookingConversationView)=>void=()=>{};
 const pending=new Promise<BookingConversationView>(done=>{resolve=done;});
 const scoped:BookingConversationPorts={...base,read:()=>pending};
 const props={ports:scoped,interpretation,privacyKey:'owner',sourceVersion:1,enabled:true};
 const rendered=render(<BookingConversation {...props}/>);const user=userEvent.setup();await user.click(screen.getByRole('button',{name:'Manage booking conversation'}));
 rendered.rerender(<BookingConversation {...props} {...(scope==='source'?{sourceVersion:2}:scope==='interpretation'?{interpretation:{...interpretation,requestId:original}}:scope==='privacy'?{privacyKey:'new-session'}:scope==='enabled'?{enabled:false}:{ports:base})}/>);
 await act(async()=>{resolve(conversation);await pending;});expect(screen.queryByText('secret')).toBeNull();expect(screen.queryByRole('button',{name:'Inspect current booking conversation'})).toBeNull();expect(base.request).toHaveBeenCalledTimes(1);
});
