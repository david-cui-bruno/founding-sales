import {mkdir} from 'node:fs/promises';
import {expect,test} from 'playwright/test';
import {assigneeFirmPage,crmState,FIRM_ID} from './support/crmFixtures.ts';
import {startAppServer,type AppServer} from './support/appServer.ts';
import {MID} from '../support/meetingTranscriptFixture.ts';
const screens=process.env['FSS_SCREENS_DIR'];let app:AppServer;
test.afterEach(async()=>{await app?.stop();});
for(const mode of ['ready','pending','manual','disabled'] as const)test(`demo recording: ${mode}, wide and narrow`,async({page})=>{
  app=await startAppServer({crm:crmState({screen:'firm',firm:assigneeFirmPage()}),operations:{
    'calling.history':()=>({calls:[]}), 'crm.firmTimeline':()=>({timeline:{events:[],nextBefore:null}}),
    'research.open':()=>({firm:null,settings:null,worstCaseRunCents:null,spend:null,notice:null,mayMutate:true,role:'salesperson'}),
    'meetings.forFirm':()=>({meetings:[{meetingId:MID,state:'booked',startsAt:'2026-10-05T14:00:00.000Z',endsAt:'2026-10-05T14:20:00.000Z',attendanceSource:null}]}),
    'recordings.state':()=>({folder:{path:'/example/demos',isDefault:true,available:true},items:[],notice:null}),
    'recordings.forFirm':()=>({truncated:false,recordings:[]}),
    'meetings.recordingSetup':()=>({view:{meetingId:MID,operationId:null,version:1,state:mode,reason:mode==='manual'?'manual_override':mode==='disabled'?'disabled':null,checkedAt:mode==='ready'?'2026-10-04T14:00:00.000Z':null,canRetry:mode==='manual',previouslyEnabled:mode==='manual'},reason:null}),
  }});
  await page.setViewportSize({width:1280,height:1000});await page.goto(app.url(`#firm/${FIRM_ID}`));
  const setup=page.getByTestId('meeting-auto-recording'),toggle=setup.getByRole('button').first();
  await expect(toggle).toHaveText(mode==='ready'?'Auto-recording set':mode==='pending'?'Setting up auto-recording':'Start recording manually');
  await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','true');
  if(mode==='ready')await expect(setup.getByText(/when you host from its desktop app/)).toBeVisible();
  if(mode==='manual')await expect(setup.getByRole('button',{name:'Retry recording setup'})).toBeVisible();
  for(const width of [1280,760]){
    await page.setViewportSize({width,height:1000});await setup.scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(screens){await mkdir(screens,{recursive:true});await page.screenshot({path:`${screens}/meeting-auto-recording-${mode}-${width}.png`});}
  }
  await toggle.click();await expect(toggle).toHaveAttribute('aria-expanded','false');
});
