import { mkdir } from 'node:fs/promises';
import { expect, test } from 'playwright/test';
import { assigneeFirmPage, crmState, FIRM_ID } from './support/crmFixtures.ts';
import { startAppServer, type AppServer } from './support/appServer.ts';
import { followThroughView } from '../support/meetingFollowThroughFixture.ts';
import { MID } from '../support/meetingTranscriptFixture.ts';
const screens = process.env['FSS_SCREENS_DIR']; let app: AppServer;
test.afterEach(async () => { await app?.stop(); });
for (const mode of ['paused','editing','held','submitted','sent','empty','error'] as const) test(`meeting follow-up: ${mode}, wide and narrow`, async ({ page }) => {
  const view=followThroughView();
  if(mode==='editing') {view.status='held';view.currentDraft!.state='editing';}
  if(mode==='held') {view.status='needs_review';view.blockers=['source_changed'];}
  if(mode==='submitted'||mode==='sent') {view.sendingPaused=false;view.blockers=[];view.currentDraft!.state=mode;}
  if(mode==='empty') {view.currentDraft=null;view.planId=null;view.blockers=['recap_template_required'];}
  app = await startAppServer({ crm: crmState({ screen: 'firm', firm: assigneeFirmPage() }), operations: {
    'calling.history': () => ({ calls: [] }), 'crm.firmTimeline': () => ({ timeline: { events: [], nextBefore: null } }),
    'research.open': () => ({ firm: null, settings: null, worstCaseRunCents: null, spend: null, notice: null, mayMutate: true, role: 'salesperson' }),
    'meetings.forFirm': () => ({ meetings: [{ meetingId: MID, state: 'held', startsAt: '2026-10-03T14:00:00.000Z', endsAt: '2026-10-03T14:20:00.000Z', attendanceSource: 'manual' }] }),
    'recordings.state': () => ({ folder: { path: '/example/demos', isDefault: true, available: true }, items: [], notice: null }),
    'recordings.forFirm': () => ({ truncated: false, recordings: [] }),
    'meetings.followThrough': () => mode==='error'?{view:null,reason:'offline'}:{view,reason:null},
    'meetings.editRecap': () => ({view:{...view,version:view.version+1,currentDraft:{...view.currentDraft!,state:'editing'}},reason:null}),
  } });
  await page.setViewportSize({width:1280,height:1000});await page.goto(app.url(`#firm/${FIRM_ID}`));
  await page.getByRole('button',{name:'Follow-up',exact:true}).click();
  await expect(page.getByRole('region',{name:'Meeting follow-up'})).toBeVisible();
  if(mode==='error')await expect(page.getByText(/could not load the latest follow-up/)).toBeVisible();
  else if(mode==='empty')await expect(page.getByText(/Add sufficient notes/)).toBeVisible();
  else await expect(page.getByText(view.currentDraft!.subject,{exact:true})).toBeVisible();
  if(mode==='editing') {await page.getByRole('button',{name:'Resume editing'}).click();await expect(page.getByLabel('Recap message')).toBeVisible();}
  if(screens!==undefined){
    await mkdir(screens,{recursive:true});
    for(const width of [1280,760]){
      await page.setViewportSize({width,height:1000});await page.getByTestId('meeting-follow-through').scrollIntoViewIfNeeded();
      await page.screenshot({path:`${screens}/meeting-follow-through-${mode}-${width}.png`});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
  }
  await page.getByRole('button',{name:'Follow-up',exact:true}).click();await expect(page.getByRole('region',{name:'Meeting follow-up'})).toHaveCount(0);
});
