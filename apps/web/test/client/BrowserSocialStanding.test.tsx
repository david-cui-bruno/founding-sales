// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {BrowserSocialStandingPlan} from '../../src/client/BrowserSocialStandingPlan.tsx';
import {BrowserSocialStandingActivity} from '../../src/client/BrowserSocialStandingActivity.tsx';
const id='10000000-0000-4000-8000-000000000001',binding={adapter:'buffer-linkedin-v1',workspaceId:id,ownerUserId:id,accountId:id,accountRevision:1,credentialId:id,credentialRevision:1,organizationId:'a'.repeat(24),channelId:'b'.repeat(24),externalId:'fictional-linkedin-service-id'};
const material={input:{state:'available',inputId:id,revision:1,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString(),bullets:'A fictional manager explained why following through matters.',context:'',experienceDate:null,publicSafe:true}};
afterEach(cleanup);
it('requires separate disclosed generation and publication grants before exact plan activation',async()=>{
 const request=vi.fn(async(path:string)=>path==='/social/inputs/read'?material:path.endsWith('/read')?{plan:null}:path.endsWith('/options')?{binding,intendedAccountId:id,accountDisplayName:'Fictional selected owner',calibrationId:id,guideRef:null,inputIds:[id]}:{status:'accepted',replayed:false,result:{planId:id,revision:1}});
 render(<BrowserSocialStandingPlan request={request}/>);const activate=await screen.findByRole('button',{name:'Activate publishing'});expect(activate).toHaveProperty('disabled',true);
 const profile=within(screen.getByRole('group',{name:'Publishing profile'}));
 expect(profile.getByText('Fictional selected owner')).toBeTruthy();expect(profile.getByText(binding.externalId)).toBeTruthy();
 expect(screen.getByRole('checkbox',{name:/Allow scheduled AI drafting/u})).toHaveProperty('checked',false);
 expect(screen.getByRole('checkbox',{name:/Allow automatic LinkedIn publishing/u})).toHaveProperty('checked',false);
 const disclosureId=screen.getByRole('checkbox',{name:/Allow automatic LinkedIn publishing/u}).getAttribute('aria-describedby');
 expect(document.getElementById(disclosureId!)).toHaveProperty('hidden',false);
 expect(document.getElementById(disclosureId!)?.textContent).toMatch(/publicly retrievable.*when handed to Buffer, before the scheduled post.*withdrawal, pause or expiry/u);
 expect(screen.queryByRole('link',{name:/View intended profile/u})).toBeNull();
 expect(screen.getByText('Calibration accepted')).toBeTruthy();
 expect(request.mock.calls.some(([path])=>path.includes('calibration')||path.endsWith('/command'))).toBe(false);
 fireEvent.click(screen.getByRole('checkbox',{name:/Allow scheduled AI drafting/u}));expect(activate).toHaveProperty('disabled',true);
 fireEvent.click(screen.getByRole('checkbox',{name:/Allow automatic LinkedIn publishing/u}));expect(activate).toHaveProperty('disabled',false);fireEvent.click(activate);
 await screen.findByText(/Plan change accepted/u);expect(request.mock.calls.filter(([path])=>path==='/social/standing-plan/command')).toHaveLength(1);
 expect(request).toHaveBeenCalledWith('/social/standing-plan/command',expect.objectContaining({operation:'save',plan:expect.objectContaining({binding,calibrationId:id,inputIds:[id],scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:true})}));
});
it('unknown command outcome offers same-operation reconciliation and never silently sends another activation',async()=>{
 const request=vi.fn(async(path:string)=>{if(path==='/social/inputs/read')return material;if(path.endsWith('/read'))return {plan:null};if(path.endsWith('/options'))return {binding,intendedAccountId:id,accountDisplayName:'Fictional selected owner',calibrationId:id,guideRef:null,inputIds:[id]};throw new Error('controlled lost response');});
 render(<BrowserSocialStandingPlan request={request}/>);await screen.findByRole('button',{name:'Activate publishing'});
 fireEvent.click(screen.getByRole('checkbox',{name:/Allow scheduled AI drafting/u}));fireEvent.click(screen.getByRole('checkbox',{name:/Allow automatic LinkedIn publishing/u}));fireEvent.click(screen.getByRole('button',{name:'Activate publishing'}));await screen.findByText(/Outcome not confirmed/u);
 expect(screen.getByRole('button',{name:'Activate publishing'}).matches(':disabled')).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Check existing plan change'}));await screen.findByText(/Outcome still unknown/u);expect(request.mock.calls.filter(([path])=>path==='/social/standing-plan/command')).toHaveLength(1);
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
it('keeps a paused plan reachable after cancelling edits and requires fresh grants to reactivate',async()=>{
 const configuration={expectedRevision:0,binding,calibrationId:id,guideRef:null,inputIds:[id],mediaScope:'none',timezone:'UTC',cadence:[1,3,5].map(weekday=>({weekday,time:'10:00'})),scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:true};
 const request=vi.fn(async(path:string)=>path==='/social/inputs/read'?material:path.endsWith('/read')?{plan:{planId:id,revision:2,state:'paused',configuration}}:{binding,intendedAccountId:id,accountDisplayName:'Fictional selected owner',calibrationId:id,guideRef:null,inputIds:[id]});
 render(<BrowserSocialStandingPlan request={request}/>);await screen.findByRole('button',{name:'Cancel editing'});
 fireEvent.click(screen.getByRole('checkbox',{name:/Allow scheduled AI drafting/u}));fireEvent.click(screen.getByRole('button',{name:'Cancel editing'}));
 fireEvent.click(screen.getByRole('button',{name:'Edit plan'}));
 expect(screen.getByRole('checkbox',{name:/Allow scheduled AI drafting/u})).toHaveProperty('checked',false);
 expect(screen.getByRole('button',{name:'Activate revised plan'})).toHaveProperty('disabled',true);
 expect(request.mock.calls.some(([path])=>path.endsWith('/command'))).toBe(false);
});
