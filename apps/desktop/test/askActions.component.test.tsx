// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Ask,type AskPorts} from '../src/renderer/ask/Ask.tsx';
afterEach(cleanup);
const requestId='11111111-1111-4111-8111-111111111111',actionId='22222222-2222-4222-8222-222222222222';
const read:AskPorts['read']=async()=>{throw new Error('not requested');};
const historyList:NonNullable<AskPorts['historyList']>=async()=>({items:[{requestId,historyRevision:1,requestVersion:4,createdAt:'2026-10-09T11:00:00.000Z',updatedAt:'2026-10-09T11:01:00.000Z',title:'Investigation',pinned:false,question:'What matters?',state:'complete',reason:null}],nextCursor:null});
const answerRead:NonNullable<AskPorts['answerRead']>=async()=>({requestId,version:4,createdAt:'2026-10-09T11:00:00.000Z',state:'complete',reason:null,question:'What matters?',fallback:null,answer:{answeredAt:'2026-10-09T11:01:00.000Z',claims:[{text:'Scheduling is difficult.',kind:'extractive',citationWindowIds:[actionId],verification:'supported'}],conflicts:[],missingEvidence:[],abstained:false,coverage:{acquisition:'unverified',semantic:'bounded_evaluated',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:'a'.repeat(64)}}});
async function openFinding(){fireEvent.click(screen.getByRole('button',{name:'Read private history'}));fireEvent.click(await screen.findByRole('button',{name:'Open investigation'}));fireEvent.click(await screen.findByRole('button',{name:'Act on claim 1'}));}
it('saves only an explicitly confirmed private preference proposal from a current supported finding',async()=>{
 const actionCreate=vi.fn(async()=>({actionId,version:1,kind:'preference' as const}));
 render(<Ask ports={{read,historyList,answerRead,...{actionCreate}}} privacyKey='owner:1' enabled/>);
 await openFinding();
 fireEvent.change(screen.getByLabelText('Follow-on action'),{target:{value:'preference'}});
 fireEvent.change(screen.getByLabelText('Proposed preference'),{target:{value:'Prefer weekday planning calls.'}});
 expect(screen.getByRole('button',{name:'Save preference proposal'}).hasAttribute('disabled')).toBe(true);
 expect(actionCreate).not.toHaveBeenCalled();
 fireEvent.click(screen.getByLabelText('Confirm this preference proposal'));
 fireEvent.click(screen.getByRole('button',{name:'Save preference proposal'}));
 expect(await screen.findByText('Preference proposal saved.')).toBeTruthy();
 expect(actionCreate).toHaveBeenCalledWith({requestId,expectedVersion:4,finding:{kind:'answer_claim',index:0},action:{kind:'preference',text:'Prefer weekday planning calls.'}});
});

it('saves a human record annotation only after explicitly selecting the record and confirming current support',async()=>{
 const lookup=vi.fn<AskPorts['read']>(async()=>({operation:'records',selection:'single',records:[{recordId:actionId,kind:'person',name:'Alex Example',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}));
 const actionCreate=vi.fn(async()=>({actionId,version:1,kind:'note' as const}));
 render(<Ask ports={{read:lookup,historyList,answerRead,actionCreate}} privacyKey='owner:1' enabled/>);
 await openFinding();fireEvent.change(screen.getByLabelText('Follow-on action'),{target:{value:'note'}});
 fireEvent.change(screen.getByLabelText('Action record name'),{target:{value:'Alex'}});
 fireEvent.click(screen.getByRole('button',{name:'Find action record'}));
 fireEvent.click(await screen.findByRole('button',{name:'Use person Alex Example'}));
 fireEvent.change(screen.getByLabelText('Your record annotation'),{target:{value:'Ask about scheduling during our call.'}});
 fireEvent.click(screen.getByLabelText('Confirm this human annotation'));
 fireEvent.click(screen.getByRole('button',{name:'Save annotation'}));
 expect(await screen.findByText('Human annotation saved.')).toBeTruthy();
 expect(actionCreate).toHaveBeenCalledWith({requestId,expectedVersion:4,finding:{kind:'answer_claim',index:0},action:{kind:'note',text:'Ask about scheduling during our call.',target:{kind:'person',personId:actionId}}});
 expect(lookup).toHaveBeenCalledWith({operation:'records',query:'Alex',kind:'people',limit:20});
});

it('creates a dated manual task for an explicitly chosen firm without claiming a promise',async()=>{
 const lookup:AskPorts['read']=async()=>({operation:'records',selection:'single',records:[{recordId:actionId,kind:'firm',name:'Orion',firmId:actionId}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}});
 const actionCreate=vi.fn(async()=>({actionId,version:1,kind:'task' as const}));
 render(<Ask ports={{read:lookup,historyList,answerRead,actionCreate}} privacyKey='owner:1' enabled/>);
 await openFinding();fireEvent.change(screen.getByLabelText('Follow-on action'),{target:{value:'task'}});
 fireEvent.change(screen.getByLabelText('Action record kind'),{target:{value:'firms'}});
 fireEvent.change(screen.getByLabelText('Action record name'),{target:{value:'Orion'}});
 fireEvent.click(screen.getByRole('button',{name:'Find action record'}));fireEvent.click(await screen.findByRole('button',{name:'Use firm Orion'}));
 fireEvent.change(screen.getByLabelText('Your task'),{target:{value:'Prepare scheduling options'}});
 fireEvent.change(screen.getByLabelText('Task due date (optional)'),{target:{value:'2026-10-10'}});
 fireEvent.change(screen.getByLabelText('Task time zone'),{target:{value:'America/Chicago'}});
 fireEvent.click(screen.getByLabelText('Confirm this manual task'));
 fireEvent.click(screen.getByRole('button',{name:'Create manual task'}));
 expect(await screen.findByText('Manual task saved.')).toBeTruthy();
 expect(actionCreate).toHaveBeenCalledWith({requestId,expectedVersion:4,finding:{kind:'answer_claim',index:0},action:{kind:'task',label:'Prepare scheduling options',due:{kind:'date',date:'2026-10-10',zone:'America/Chicago',expression:'2026-10-10'},target:{kind:'firm',firmId:actionId}}});
});

it('evicts the finding and private drafts after a current-action refusal without retrying',async()=>{
 const actionCreate=vi.fn(async()=>{throw new Error('source_changed');});
 render(<Ask ports={{read,historyList,answerRead,actionCreate}} privacyKey='owner:1' enabled/>);
 await openFinding();fireEvent.change(screen.getByLabelText('Follow-on action'),{target:{value:'preference'}});
 fireEvent.change(screen.getByLabelText('Proposed preference'),{target:{value:'Private proposal'}});
 fireEvent.click(screen.getByLabelText('Confirm this preference proposal'));fireEvent.click(screen.getByRole('button',{name:'Save preference proposal'}));
 expect(await screen.findByText('Action could not be confirmed. Check current evidence before trying again.')).toBeTruthy();
 expect(screen.queryByText('Scheduling is difficult.')).toBeNull();
 expect(screen.queryByLabelText('Proposed preference')).toBeNull();
 expect(screen.queryByText('Investigation')).toBeNull();
 expect(actionCreate).toHaveBeenCalledTimes(1);
});
