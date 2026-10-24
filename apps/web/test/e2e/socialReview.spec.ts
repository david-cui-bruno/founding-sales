import type {Page} from 'playwright/test';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {browserRequest,browserSession} from '../support/browser.ts';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {routeManualProvider,loginManual} from '../support/manualProspectSeed.ts';
import {seedSocialReview,socialProductSnapshot,socialFixtureText,socialFixtureFact} from '../support/socialReviewSeed.ts';
let app:Awaited<ReturnType<typeof startManualProspectApp>>,seed:Awaited<ReturnType<typeof seedSocialReview>>,baseline:Awaited<ReturnType<typeof socialProductSnapshot>>;
const panel=(page:Page)=>page.getByRole('region',{name:'Private social review',exact:true});
async function load(page:Page){await panel(page).getByRole('button',{name:'Read retained social suggestions'}).click();await expect(panel(page).getByRole('button',{name:'Read retained social suggestions'})).toBeEnabled();}
async function ready(page:Page){await loginManual(page,app);await expect(panel(page)).toBeVisible();await load(page);await expect(panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'})).toBeEnabled();}
async function use(page:Page){await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();await expect(panel(page).getByLabel('Private social text')).toHaveValue(socialFixtureText);}
test.beforeAll(async()=>{app=await startManualProspectApp('769');seed=await seedSocialReview(app);baseline=await socialProductSnapshot(app);});
test.afterAll(async()=>{try{if(app&&baseline)expect(await socialProductSnapshot(app)).toEqual(baseline);}finally{await app?.stop();}});
test.beforeEach(async({researchPage:page})=>{
 await app.fixture.db.query('UPDATE outreach_answer_block_versions SET retired_at=NULL WHERE block_id=$1',[seed.ref.id]);
 await app.fixture.db.query("UPDATE social_draft_requests SET state='ready',concepts=$2::jsonb,reason=NULL,created_at=now(),deadline_at=now()+interval '30 minutes' WHERE id=$1",[seed.requestId,JSON.stringify(seed.concepts)]);
 await routeManualProvider(page,app);
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/browser/api/social')){expect(request.method()).toBe('POST');expect(['/browser/api/social/drafts','/browser/api/social/drafts/read']).toContain(url.pathname);expect(request.postData()).not.toContain('Private edited prose');}});
});
test.afterEach(async({researchPage:page})=>{
 expect(await socialProductSnapshot(app)).toEqual(baseline);
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain(socialFixtureText);expect(storage).not.toContain(socialFixtureFact);expect(storage).not.toContain('Private edited prose');
});
test('actual signed HTTPS OIDC app_runtime review adopts current retained ready suggestion, edits privately and reload/discard loses it',async({researchPage:page})=>{
 await ready(page);expect(app.runtimeRequests()).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
 await panel(page).getByText('Current approved factual inputs (1, at most 20)').click();await expect(panel(page)).toContainText(socialFixtureFact);
 await use(page);await expect(panel(page)).toContainText(`Selected origin request ${seed.requestId}`);await expect(panel(page)).toContainText('not proof of semantic support');await panel(page).getByLabel('Private social text').fill('Private edited prose');await panel(page).getByLabel('Scratch format').selectOption('comment');await expect(panel(page)).toContainText('unverified and human-review-required');
 await panel(page).getByRole('button',{name:'Discard private scratch'}).click();await expect(panel(page).getByLabel('Private social text')).toHaveValue('');await panel(page).getByLabel('Private social text').fill('Private edited prose');await page.reload();await expect(panel(page).getByLabel('Private social text')).toHaveValue('');
});
test('empty other workspace permits useful manual post/comment scratch without account or model and cannot read foreign owner request',async({researchPage:page})=>{
 await loginManual(page,app,'beta');await expect(panel(page)).toBeVisible();await load(page);await expect(panel(page)).toContainText('No retained suggestions.');await panel(page).getByLabel('Scratch format').selectOption('comment');await panel(page).getByLabel('Private social text').fill('Private edited prose');expect((await browserRequest(page,'/social/drafts/read',{body:{requestId:seed.requestId}})).status).toBe(404);
 expect((await browserRequest(page,'/social/drafts',{body:{},csrf:'forged'})).status).toBe(403);expect((await browserRequest(page,'/social/drafts',{body:{},revision:'stale'})).status).toBe(409);
});
test('retired current fact invalidates on explicit reread, clears stale evidence and refuses adoption without publication',async({researchPage:page})=>{
 await ready(page);await app.fixture.db.query('UPDATE outreach_answer_block_versions SET retired_at=now() WHERE block_id=$1',[seed.ref.id]);await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();await expect(panel(page)).toContainText('Suggestion changed, expired or unavailable');await expect(panel(page).getByLabel('Private social text')).toHaveValue('');await expect(panel(page)).not.toContainText(socialFixtureText);
 expect((await app.fixture.db.query('SELECT state,concepts,reason FROM social_draft_requests WHERE id=$1',[seed.requestId])).rows[0]).toMatchObject({state:'review',concepts:null,reason:'source_changed_or_unavailable'});
 await load(page);await expect(panel(page)).toContainText('Not available for adoption');
});
test('expired ready request returns no generated prose and is not adoptable',async({researchPage:page})=>{
 await ready(page);await app.fixture.db.query("UPDATE social_draft_requests SET created_at=now()-interval '31 minutes',deadline_at=now()-interval '1 minute' WHERE id=$1",[seed.requestId]);await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();await expect(panel(page)).toContainText('Suggestion changed, expired or unavailable');await expect(panel(page).getByLabel('Private social text')).toHaveValue('');await load(page);await expect(panel(page)).toContainText('expired');await expect(panel(page)).not.toContainText(socialFixtureText);
});
for(const change of ['device','session','membership','role','expiry'] as const)test(`exact ${change} auth after request-row wait refuses held adoption and clears composer`,async({researchPage:page})=>{
 await ready(page);await panel(page).getByLabel('Private social text').fill('Private edited prose');const session=await browserSession(page);if(session.status!=='signed_in')throw Error('Signed session required');
 const clock=app.fixture.deps.now();
 const blocker=await app.fixture.database.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT id FROM social_draft_requests WHERE id=$1 FOR UPDATE',[seed.requestId]);
 const answer=page.waitForResponse(response=>response.url().endsWith('/browser/api/social/drafts/read'));
 await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();
 try{
  await expect.poll(async()=>Number((await app.fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM social_draft_requests%FOR UPDATE'")).rows[0]?.['n'])).toBe(1);
  if(change==='device')await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[session.deviceId]);
  if(change==='session')await app.fixture.db.query("UPDATE sessions SET status='ended',ended_at=now(),end_reason='signed_out' WHERE device_id=$1 AND status='active'",[session.deviceId]);
  if(change==='expiry')app.fixture.advance(61*60*1000);
  if(change==='membership')await app.fixture.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[session.workspaceId,session.userId]);
  if(change==='role')await app.fixture.db.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[session.workspaceId,session.userId]);
 }finally{await blocker.query('ROLLBACK');}
 try{expect((await answer).status()).toBe(401);expect((await app.fixture.db.query('SELECT state,concepts FROM social_draft_requests WHERE id=$1',[seed.requestId])).rows[0]).toEqual({state:'ready',concepts:seed.concepts});await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);}finally{
  app.fixture.setNow(clock);
  await app.fixture.db.query("UPDATE workspace_memberships SET status='active',role='admin',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[session.workspaceId,session.userId]);
 }
});
test('current source change committed during fact lock wait is revalidated before adoption',async({researchPage:page})=>{
 await ready(page);const blocker=await app.fixture.database.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('UPDATE outreach_answer_block_versions SET retired_at=now() WHERE block_id=$1',[seed.ref.id]);
 const answer=page.waitForResponse(response=>response.url().endsWith('/browser/api/social/drafts/read'));await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();
 try{await expect.poll(async()=>Number((await app.fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT b.id FROM outreach_answer_blocks%'")).rows[0]?.['n'])).toBe(1);}finally{await blocker.query('COMMIT');}
 expect((await answer).status()).toBe(200);await expect(panel(page)).toContainText('Suggestion changed, expired or unavailable');await expect(panel(page).getByLabel('Private social text')).toHaveValue('');
});
test('workspace read revalidates device after a database wait and cannot restore private manual prose',async({researchPage:page})=>{
 await ready(page);await panel(page).getByLabel('Private social text').fill('Private edited prose');const session=await browserSession(page);if(session.status!=='signed_in')throw Error('Signed session required');
 const blocker=await app.fixture.database.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT id FROM social_draft_requests WHERE id=$1 FOR UPDATE',[seed.requestId]);
 const answer=page.waitForResponse(response=>response.url().endsWith('/browser/api/social/drafts'));await panel(page).getByRole('button',{name:'Read retained social suggestions'}).click();
 try{await expect.poll(async()=>Number((await app.fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM social_draft_requests%FOR UPDATE'")).rows[0]?.['n'])).toBe(1);await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[session.deviceId]);}finally{await blocker.query('ROLLBACK');}
 expect((await answer).status()).toBe(401);await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);
});
test('deadline crossing a source lock wait returns expired without retained generated prose',async({researchPage:page})=>{
 await ready(page);await app.fixture.db.query("UPDATE social_draft_requests SET deadline_at=clock_timestamp()+interval '1 second' WHERE id=$1",[seed.requestId]);
 const blocker=await app.fixture.database.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT block_id FROM outreach_answer_block_versions WHERE block_id=$1 FOR UPDATE',[seed.ref.id]);
 const answer=page.waitForResponse(response=>response.url().endsWith('/browser/api/social/drafts/read'));await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();
 try{await expect.poll(async()=>Number((await app.fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT b.id FROM outreach_answer_blocks%'")).rows[0]?.['n'])).toBe(1);await blocker.query('SELECT pg_sleep(1.1)');}finally{await blocker.query('COMMIT');}
 const response=await answer;expect(response.status()).toBe(200);expect(await response.json()).toMatchObject({request:{state:'expired',concepts:null}});await expect(panel(page)).toContainText('Suggestion changed, expired or unavailable');await expect(panel(page).getByLabel('Private social text')).toHaveValue('');
});
test('late successful adoption cannot restore composer after cross-tab logout',async({researchPage:page})=>{
 await ready(page);const second=await page.context().newPage();await second.goto(app.origin);await expect(second.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();let release=()=>{},reached=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{reached=resolve;});
 await page.route('**/browser/api/social/drafts/read',async route=>{const response=await route.fetch();reached();await held;await route.fulfill({response});},{times:1});await panel(page).getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}).click();await seen;
 const delivered=page.waitForResponse(response=>response.url().endsWith('/browser/api/social/drafts/read'));try{await second.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();}finally{release();}await delivered;await expect(panel(page)).toHaveCount(0);await expect(page.getByText(socialFixtureText,{exact:true})).toHaveCount(0);await second.close();
});
