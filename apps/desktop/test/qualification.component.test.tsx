// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {QualificationPanel,type QualificationPorts} from '../src/renderer/sourcing/QualificationPanel.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {QualificationView} from '@fss/contracts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const view:QualificationView={candidateId:id,runId:id,candidateRevision:2,status:'review',reason:null,admissionReason:null,requestedAt:'2026-10-05T00:00:00Z',deadlineAt:'2026-10-05T00:30:00Z',observations:[],facts:[],verdict:{decision:'review',rank:'fit_only',reasons:[],unknowns:['maintenance_need_unconfirmed'],evidenceIds:[],policyVersion:'qualification-v1'},openingQuestion:'How does your team handle maintenance requests today?',admission:null,history:[]};
const ports=():QualificationPorts=>({read:vi.fn(async()=>({view,reason:null})),qualify:vi.fn(async()=>({result:{runId:id},reason:null})),admit:vi.fn(async()=>({result:{firmId:id,routeId:id,alreadyAdmitted:false},reason:null})),feedback:vi.fn(async()=>({result:{id},reason:null}))});
it('shows uncertainty and keeps reviewed admission separate from research',async()=>{
 const p=ports();render(<QualificationPanel candidateId={id} revision={2} ports={p}/>);
 fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));
 expect(await screen.findByText('Timing unknown')).toBeTruthy();expect(screen.getByText(view.openingQuestion!)).toBeTruthy();
 expect(p.admit).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Add to call queue'}));
 await waitFor(()=>expect(p.admit).toHaveBeenCalledWith(expect.objectContaining({candidateId:id,expectedRevision:2,qualificationRunId:id,mode:'reviewed'})));
});
it('hides admission when evidence is stale and clearly labels previous evidence',async()=>{
 const p=ports();p.read=vi.fn(async()=>({view:{...view,status:'unavailable' as const,reason:'source_unavailable',verdict:null,openingQuestion:null},reason:null}));
 render(<QualificationPanel candidateId={id} revision={3} ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));
 expect(await screen.findByText(/Evidence unavailable/)).toBeTruthy();expect(screen.queryByRole('button',{name:'Add to call queue'})).toBeNull();
});
it('keeps uncertain admission receipts across navigation and retries without double submission',async()=>{
 const p=ports();p.admit=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({result:{firmId:id,routeId:id,alreadyAdmitted:true},reason:null});
 const {rerender}=render(<DraftsProvider><QualificationPanel candidateId={id} revision={2} ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));fireEvent.click(await screen.findByRole('button',{name:'Add to call queue'}));
 await screen.findByRole('button',{name:'Retry evidence action'});
 rerender(<DraftsProvider><span>Elsewhere</span></DraftsProvider>);rerender(<DraftsProvider><QualificationPanel candidateId={id} revision={2} ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Retry evidence action'}));
 await waitFor(()=>expect(p.admit).toHaveBeenCalledTimes(2));expect(vi.mocked(p.admit).mock.calls[0]).toEqual(vi.mocked(p.admit).mock.calls[1]);
});

it('labels team-growth investigation without inventing a coordination vacancy',async()=>{
 const p=ports();p.read=vi.fn(async()=>({view:{...view,verdict:{...view.verdict!,rank:'investigation' as const,reasons:['team_growth_for_review']}},reason:null}));
 render(<QualificationPanel candidateId={id} revision={2} ports={p}/>);
 fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));
 expect(await screen.findByText('Team growth worth investigating')).toBeTruthy();
 expect(screen.queryByText('Coordination role worth investigating')).toBeNull();
 expect(p.admit).not.toHaveBeenCalled();
});
