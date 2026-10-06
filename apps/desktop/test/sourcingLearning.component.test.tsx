// @vitest-environment jsdom
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Learning} from '../src/renderer/sourcing/Learning.tsx';
import type {LearningReport} from '@fss/contracts';
afterEach(cleanup);
const report:LearningReport={from:'2026-09-05T00:00:00.000Z',to:'2026-10-05T00:00:00.000Z',asOf:'2026-10-05T00:00:00.000Z',cohorts:[],maturity:[{ageBand:'0–6 days',firms:0}],firms:[],coverage:{candidates:30,qualified:0,admitted:0,unavailable:4},search:{attempts:6,creditsReserved:6}};
it('shows pre-conversation coverage and missing denominators without declaring a winner',async()=>{
 render(<Learning read={async()=>({view:report,reason:null})}/>);
 expect(await screen.findByText('30 candidates found')).toBeTruthy();expect(screen.getByText(/No contacted firms/)).toBeTruthy();expect(screen.queryByText('0%')).toBeNull();expect(screen.queryByText(/winner/i)).toBeNull();
});
it('keeps unavailable distinct from an empty report and lets the user retry',async()=>{
 const read=vi.fn().mockResolvedValueOnce({view:null,reason:'http_503'}).mockResolvedValueOnce({view:report,reason:null});render(<Learning read={read}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Retry results'}));expect(await screen.findByText('30 candidates found')).toBeTruthy();
});
import {Targeting,type TargetingPorts} from '../src/renderer/sourcing/Targeting.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
it('saves a targeting proposal without applying it and preserves an unsent draft across navigation',async()=>{
 const ports:TargetingPorts={read:vi.fn(async()=>({view:{canEdit:true,policy:{version:'targeting-v1',queries:[{id:'dfw',query:'Dallas property management',locality:'Dallas',region:'TX' as const}],rankOrder:['help_request','operational_burden','investigation','fit_only']},proposals:[]},reason:null})),save:vi.fn(async()=>({result:{id:'11111111-1111-4111-8111-111111111111',revision:1},reason:null})),apply:vi.fn(async()=>({result:{policyVersion:'new'},reason:null}))};
 const {rerender}=render(<DraftsProvider><Targeting ports={ports} enabled/></DraftsProvider>);fireEvent.click(screen.getByRole('button',{name:'Review targeting'}));
 fireEvent.change(await screen.findByLabelText('Reason for change'),{target:{value:'Test an explicit maintenance coordinator signal.'}});
 rerender(<DraftsProvider><span>Another screen</span></DraftsProvider>);rerender(<DraftsProvider><Targeting ports={ports} enabled/></DraftsProvider>);
 expect((await screen.findByLabelText('Reason for change') as HTMLTextAreaElement).value).toContain('coordinator');
 fireEvent.click(screen.getByRole('button',{name:'Save proposal'}));expect(await screen.findByText(/Proposal saved/)).toBeTruthy();expect(ports.apply).not.toHaveBeenCalled();
});
it('uses held qualified demos, not bookings, as the conversion numerator',async()=>{
 const cohort={hypothesis:'fit_only',policyVersion:'v1',acquisition:'manual',firms:1,contacted:1,reached:1,confirmedPain:0,booked:1,held:0,qualified:0,won:0,unreached:0,unknownQualification:1,interactions:{answeredCalls:1,confirmedPainCalls:0},researchGrossCents:0,researchCashCents:0};
 render(<DraftsProvider><Learning read={async()=>({view:{...report,cohorts:[cohort]},reason:null})}/></DraftsProvider>);
 expect(await screen.findByText(/Held qualified demos per contacted firm: 0 \/ 1 \(0%\)/)).toBeTruthy();
});
