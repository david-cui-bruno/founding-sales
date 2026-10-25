import {randomUUID} from 'node:crypto';
import type {Page} from 'playwright/test';
import {manualProspectListSchema} from '@fss/contracts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {browserRequest,browserSession} from '../support/browser.ts';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {seedManualProspects,manualProductSnapshot,routeManualProvider,loginManual} from '../support/manualProspectSeed.ts';
import {MANUAL_PROSPECT_PENDING_KEY} from '../../src/client/ManualProspectPending.ts';
import {inspectManualProspect} from '../support/manualProspectInspector.ts';
const read='/sourcing/candidates/prospects/list',feedback='/sourcing/candidates/prospects/feedback';
let app:Awaited<ReturnType<typeof startManualProspectApp>>,rows:Awaited<ReturnType<typeof seedManualProspects>>,baseline:Awaited<ReturnType<typeof manualProductSnapshot>>;
const panel=(page:Page)=>page.getByRole('region',{name:'Manual prospect worklist',exact:true});
const card=(page:Page,id:string)=>panel(page).getByRole('article',{name:`Manual prospect ${id}`,exact:true});
async function ready(page:Page){await expect(panel(page).getByRole('table').getByRole('row')).toHaveCount(51);await expect(panel(page).getByRole('button',{name:'Refresh retained worklist',exact:true})).toBeEnabled();}
async function refresh(page:Page){const answer=page.waitForResponse(response=>response.url().endsWith(`/browser/api${read}`));await panel(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();const response=await answer;expect(response.status()).toBe(200);return manualProspectListSchema.parse(await response.json());}
test.beforeAll(async()=>{app=await startManualProspectApp();rows=await seedManualProspects(app);baseline=await manualProductSnapshot(app);});
test.afterAll(async()=>{try{if(app&&baseline)expect(await manualProductSnapshot(app)).toEqual(baseline);}finally{await app?.stop();}});
test.beforeEach(async({researchPage:page})=>{
 await app.fixture.db.query('DELETE FROM sourcing_manual_prospect_states');await routeManualProvider(page,app);
 page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/browser/api/'))expect(['/browser/api/today','/browser/api/today/actions/v4','/browser/api/sourcing/research-firms/list',`/browser/api${read}`,`/browser/api${feedback}`]).toContain(path);});
});
test.afterEach(async({researchPage:page})=>{
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toMatch(/Unverified raw|Ordinary unverified|https:|CDLA|source\.example/u);expect(await manualProductSnapshot(app)).toEqual(baseline);
});
test('actual signed OIDC runtime-role browser initially shows raw discovery and ordinary, safe HTML/notices/unknown phone and bounded dedup pages',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);expect(app.runtimeRequests()).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
 await inspectManualProspect(page,rows.ordinaryId);await expect(card(page,rows.ordinaryId)).toContainText('Ordinary unverified 764');await inspectManualProspect(page,rows.rawId);await expect(card(page,rows.rawId)).toContainText('<img src=x onerror=alert(1)> Unverified raw');
 await expect(card(page,rows.rawId)).toContainText('Phone unknown');await expect(card(page,rows.rawId)).toContainText('CDLA-Permissive-2.0');await expect(panel(page).getByRole('img')).toHaveCount(0);await expect(panel(page).locator('a[href^="javascript:"]')).toHaveCount(0);
 const first=await refresh(page);expect(first.prospects.every(p=>p.qualification==='unverified'&&p.contactAuthority==='not_granted'&&p.observedPhone===null)).toBe(true);expect(first.prospects.find(p=>p.observedName==='Possible duplicate observation')?.possibleDuplicateCount).toBe(1);
 const next=page.waitForResponse(response=>response.url().endsWith(`/browser/api${read}`));await panel(page).getByRole('button',{name:'Next prospect page',exact:true}).click();const response=await next;expect(response.request().postDataJSON()).toEqual({state:'all',offset:50});const last=manualProspectListSchema.parse(await response.json());expect(last.prospects).toHaveLength(4);await expect(panel(page).getByRole('table').getByRole('row')).toHaveCount(5);await expect(card(page,rows.rawId)).toHaveCount(0);
});
test('manual keep/skip/wrong-number persists independently through reload; lost response reconciles same UUID only',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);await inspectManualProspect(page,rows.rawId);
 for(const [button,state] of [['Keep','kept'],['Skip','skipped']] as const){const response=page.waitForResponse(response=>response.url().endsWith(`/browser/api${feedback}`));await card(page,rows.rawId).getByRole('button',{name:button,exact:true}).click();expect(await (await response).json()).toMatchObject({status:'accepted',result:{candidateId:rows.rawId,state}});await expect(card(page,rows.rawId)).toContainText(`Manual state ${state}`);}
 let firstBody:unknown;await page.route(`**/browser/api${feedback}`,async route=>{firstBody=route.request().postDataJSON();expect(await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY)).not.toBeNull();const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await card(page,rows.rawId).getByRole('button',{name:'Wrong number',exact:true}).click();await expect(panel(page).getByRole('button',{name:'Reconcile same manual feedback'})).toBeEnabled();
 const held=await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY);await page.reload();await ready(page);await inspectManualProspect(page,rows.rawId);expect(await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY)).toBe(held);await expect(card(page,rows.rawId)).toContainText('Manual state wrong number');
 const reconcile=page.waitForResponse(response=>response.url().endsWith(`/browser/api${feedback}`));await panel(page).getByRole('button',{name:'Reconcile same manual feedback'}).click();const answer=await reconcile;expect(answer.request().postDataJSON()).toEqual(firstBody);expect(await answer.json()).toMatchObject({status:'accepted',replayed:true});await expect(panel(page).getByRole('button',{name:'Reconcile same manual feedback'})).toHaveCount(0);
});
test('exact stale revision and restricted/deleted source refuse feedback without CRM or policy effects',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);
 const stale=await browserRequest(page,feedback,{body:{candidateId:rows.rawId,expectedRevision:2,state:'kept',commandId:randomUUID()}});expect(stale).toMatchObject({status:200,body:{status:'refused',reason:'candidate_changed'}});
 await app.fixture.db.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[rows.ordinaryId]);
 try{const list=await refresh(page);expect(list.prospects.some(p=>p.candidateId===rows.ordinaryId)).toBe(false);const refused=await browserRequest(page,feedback,{body:{candidateId:rows.ordinaryId,expectedRevision:1,state:'kept',commandId:randomUUID()}});expect(refused).toMatchObject({status:200,body:{status:'refused',reason:'candidate_unavailable'}});}finally{await app.fixture.db.query('UPDATE sourcing_candidates SET source_check=NULL WHERE id=$1',[rows.ordinaryId]);}
 const missing=await browserRequest(page,feedback,{body:{candidateId:randomUUID(),expectedRevision:1,state:'kept',commandId:randomUUID()}});expect(missing).toMatchObject({status:200,body:{status:'refused',reason:'candidate_unavailable'}});
});
test('workspace/admin isolation and exact CSRF/session revision refusal preserve browser authority',async({researchPage:page})=>{
 await loginManual(page,app,'beta');await expect(panel(page).getByRole('article')).toHaveCount(1);await expect(card(page,rows.betaId)).toBeVisible();await expect(card(page,rows.rawId)).toHaveCount(0);
 const foreign=await browserRequest(page,feedback,{body:{candidateId:rows.rawId,expectedRevision:1,state:'kept',commandId:randomUUID()}});expect(foreign).toMatchObject({status:200,body:{reason:'candidate_unavailable'}});
 expect((await browserRequest(page,read,{body:{state:'all',offset:0},csrf:'forged'})).status).toBe(403);expect((await browserRequest(page,read,{body:{state:'all',offset:0},revision:'stale'})).status).toBe(409);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await loginManual(page,app,'sales');await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);expect((await browserRequest(page,read,{body:{state:'all',offset:0}})).status).toBe(403);
});
test('session revocation while feedback waits on exact candidate lock refuses the write and clears custody',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);await inspectManualProspect(page,rows.rawId);const session=await browserSession(page);if(session.status!=='signed_in')throw Error('Signed session required');
 const blocker=await app.fixture.database.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT id FROM sourcing_candidates WHERE id=$1 FOR UPDATE',[rows.rawId]);
 const answer=page.waitForResponse(response=>response.url().endsWith(`/browser/api${feedback}`));await card(page,rows.rawId).getByRole('button',{name:'Keep',exact:true}).click();
 try{
  await expect.poll(async()=>Number((await app.fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT revision FROM sourcing_candidates%'")).rows[0]?.['n'])).toBe(1);
  await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[session.deviceId]);
 }finally{await blocker.query('ROLLBACK');}
 expect((await answer).status()).toBe(401);await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();expect((await app.fixture.db.query('SELECT * FROM sourcing_manual_prospect_states')).rows).toEqual([]);expect(await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY)).toBeNull();
});
test('revoked session clears memory/custody and late responses cannot restore private worklist after cross-tab logout',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);const session=await browserSession(page);if(session.status!=='signed_in')throw Error('Signed session required');
 await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[session.deviceId]);await panel(page).getByRole('button',{name:'Refresh retained worklist'}).click();await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);
 await loginManual(page,app);await ready(page);const second=await page.context().newPage();await second.goto(app.origin);await expect(second.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 let release=()=>{},reached=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{reached=resolve;});
 await page.route(`**/browser/api${read}`,async route=>{const response=await route.fetch();reached();await held;await route.fulfill({response});},{times:1});await panel(page).getByRole('button',{name:'Refresh retained worklist'}).click();await seen;
 const delivered=page.waitForResponse(response=>response.url().endsWith(`/browser/api${read}`));try{await second.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();}finally{release();}await delivered;await expect(panel(page)).toHaveCount(0);expect(await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY)).toBeNull();await second.close();
});
