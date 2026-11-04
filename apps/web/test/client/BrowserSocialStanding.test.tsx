// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserSocialStandingPlan} from '../../src/client/BrowserSocialStandingPlan.tsx';
import {BrowserSocialStandingActivity} from '../../src/client/BrowserSocialStandingActivity.tsx';
const id='10000000-0000-4000-8000-000000000001',binding={workspaceId:id,ownerUserId:id,accountId:id,accountRevision:1,sessionId:id,sessionRevision:1,externalId:'https://www.linkedin.com/in/fictional-controlled-fixture/'};
afterEach(cleanup);
it('requires separate disclosed generation and publication grants before exact plan activation',async()=>{
 const request=vi.fn(async(path:string)=>path.endsWith('/read')?{plan:null}:path.endsWith('/options')?{binding,intendedAccountId:id,calibrationId:id,guideRef:null,inputIds:[id]}:{status:'accepted',replayed:false,result:{planId:id,revision:1}});
 render(<BrowserSocialStandingPlan request={request}/>);fireEvent.click(screen.getByRole('button',{name:'Read current plan'}));await screen.findByText(/Calibration: complete/u);
 const activate=screen.getByRole('button',{name:'Activate exact revised plan'});expect(activate).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('checkbox',{name:/Authorize scheduled Bedrock/u}));expect(activate).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('checkbox',{name:/Authorize unattended publication/u}));expect(activate).toHaveProperty('disabled',false);fireEvent.click(activate);
 await screen.findByText(/Plan change accepted/u);expect(request).toHaveBeenLastCalledWith('/social/standing-plan/command',expect.objectContaining({operation:'save',plan:expect.objectContaining({binding,calibrationId:id,inputIds:[id],scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:true})}));
});
it('unknown command outcome offers same-operation reconciliation and never silently sends another activation',async()=>{
 const request=vi.fn(async(path:string)=>{if(path.endsWith('/read'))return {plan:null};if(path.endsWith('/options'))return {binding,intendedAccountId:id,calibrationId:id,guideRef:null,inputIds:[id]};throw new Error('controlled lost response');});
 render(<BrowserSocialStandingPlan request={request}/>);fireEvent.click(screen.getByRole('button',{name:'Read current plan'}));await screen.findByText(/Calibration: complete/u);
 fireEvent.click(screen.getByRole('checkbox',{name:/Authorize scheduled Bedrock/u}));fireEvent.click(screen.getByRole('checkbox',{name:/Authorize unattended publication/u}));fireEvent.click(screen.getByRole('button',{name:'Activate exact revised plan'}));await screen.findByText(/Outcome not confirmed/u);
 fireEvent.click(screen.getByRole('button',{name:'Reconcile same plan operation'}));await screen.findByText(/Outcome still unknown/u);expect(request.mock.calls.filter(([path])=>path==='/social/standing-plan/command')).toHaveLength(1);
});
it('keeps source-bound queued CAS edits and does not expose edit/replacement for scheduled or unknown work',async()=>{
 const base={slotId:id,revision:7,publishAt:'2026-11-06T15:00:00Z',localTarget:null,localWeek:'2026-11-02',state:'queued',reason:null,text:'My controlled original update.',permalink:null,inputRefs:[{inputId:id,revision:4}],image:null};let state='queued';
 const request=vi.fn(async(path:string)=>path.endsWith('/activity')?{items:[{...base,state}],remainingThisWeek:2}:{status:'refused',replayed:false,reason:'stale_revision'});
 render(<BrowserSocialStandingActivity request={request}/>);fireEvent.click(screen.getByRole('button',{name:'Read activity'}));await screen.findByText(/Sticky source lineage/u);
 fireEvent.change(screen.getByRole('textbox',{name:'Queued text (source lineage remains bound)'}),{target:{value:'My edited controlled update.'}});fireEvent.click(screen.getByRole('button',{name:'Save exact queued edit'}));await screen.findByText(/Change refused: stale revision/u);
 expect(request).toHaveBeenLastCalledWith('/social/standing-plan/command',{operation:'edit',slotId:id,expectedRevision:7,text:'My edited controlled update.'});
 state='scheduled';fireEvent.click(screen.getByRole('button',{name:'Read activity'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'Save exact queued edit'})).toBeNull());expect(screen.queryByRole('button',{name:'Skip this slot'})).toBeNull();expect(screen.getByText(/Scheduled means accepted remotely/u)).toBeTruthy();expect(screen.queryByRole('link',{name:'Observed published post'})).toBeNull();
 state='unknown';fireEvent.click(screen.getByRole('button',{name:'Read activity'}));await screen.findByRole('heading',{name:/unknown/u});expect(screen.queryByRole('textbox')).toBeNull();
});
it('shows a nonexistent DST target as a consumed skipped slot without fabricating a publication instant',async()=>{
 const request=vi.fn(async()=>({items:[{slotId:id,revision:1,publishAt:null,localTarget:'2027-03-14 02:30 America/New_York',localWeek:'2027-03-08',state:'skipped',reason:'daylight_saving_gap',text:null,permalink:null,inputRefs:[],image:null}],remainingThisWeek:2}));
 render(<BrowserSocialStandingActivity request={request}/>);fireEvent.click(screen.getByRole('button',{name:'Read activity'}));await screen.findByText(/This local clock time does not exist/u);expect(screen.getByRole('heading',{name:/2027-03-14 02:30 America\/New_York/u})).toBeTruthy();expect(screen.queryByRole('button',{name:'Skip this slot'})).toBeNull();
});
