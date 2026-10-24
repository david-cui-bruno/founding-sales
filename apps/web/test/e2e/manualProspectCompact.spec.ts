import {randomUUID} from 'node:crypto';
import type {Page} from 'playwright/test';
import {manualProspectListSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {rememberExpiredManualSources} from '@fss/domain/sourcing/manualProspectSourceLoss.ts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {seedCompactManualProspects} from '../support/manualProspectCompactSeed.ts';
import {manualProductSnapshot,routeManualProvider,loginManual} from '../support/manualProspectSeed.ts';
import {browserRequest} from '../support/browser.ts';
import {MANUAL_PROSPECT_PENDING_KEY} from '../../src/client/ManualProspectPending.ts';
const read='/sourcing/candidates/prospects/list',feedback='/sourcing/candidates/prospects/feedback';
let app:Awaited<ReturnType<typeof startManualProspectApp>>,rows:Awaited<ReturnType<typeof seedCompactManualProspects>>,baseline:Awaited<ReturnType<typeof manualProductSnapshot>>;
const queue=(page:Page)=>page.getByRole('region',{name:'Manual prospect worklist',exact:true});
const row=(page:Page,id:string)=>queue(page).getByRole('article',{name:`Manual prospect ${id}`,exact:true});
async function ready(page:Page){await expect(queue(page).getByRole('article')).toHaveCount(50);await expect(queue(page).getByRole('button',{name:'Refresh retained worklist',exact:true})).toBeEnabled();}
async function refresh(page:Page){const answer=page.waitForResponse(response=>response.url().endsWith(`/browser/api${read}`));await queue(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();const response=await answer;expect(response.status()).toBe(200);return manualProspectListSchema.parse(await response.json());}
test.beforeAll(async()=>{app=await startManualProspectApp('767');rows=await seedCompactManualProspects(app);baseline=await manualProductSnapshot(app);});
test.afterAll(async()=>{try{if(app&&baseline)expect(await manualProductSnapshot(app)).toEqual(baseline);}finally{await app?.stop();}});
test.beforeEach(async({researchPage:page})=>{
 await app.fixture.db.query('DELETE FROM sourcing_manual_prospect_states');await routeManualProvider(page,app);
 page.on('request',request=>{const url=new URL(request.url());expect(url.origin).toBe(app.origin);if(url.pathname.startsWith('/browser/api/'))expect(['/browser/api/today','/browser/api/today/actions/v4','/browser/api/sourcing/research-firms/list',`/browser/api${read}`,`/browser/api${feedback}`]).toContain(url.pathname);});
});
test.afterEach(async({researchPage:page})=>{
 expect(await manualProductSnapshot(app)).toEqual(baseline);
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toMatch(/Boston Property|Retained raw|phone-source|12145550123|CDLA|https:/u);
});
test('NEW767 real HTTPS/OIDC/app_runtime queue is compact, retains original labels/notices, all phone states, safe titles and bounded pages',async({researchPage:page})=>{
 await page.setViewportSize({width:1280,height:900});await loginManual(page,app);await ready(page);
 expect(app.runtimeRequests()).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
 for(const id of [rows.memberA.id,rows.memberB.id]){
  await expect(row(page,id).getByRole('heading',{name:'Boston Property Management',exact:true})).toBeVisible();await expect(row(page,id)).toContainText('apparent company');
  const details=row(page,id).locator('details');await expect(details).not.toHaveAttribute('open','');
  const box=await row(page,id).boundingBox();expect(box?.height).toBeLessThan(180);
  await row(page,id).getByText('Observed name, sources and details',{exact:true}).click();
  await expect(details).toHaveAttribute('open','');await expect(details).toContainText(id===rows.memberA.id?rows.memberA.input.row.firmName:rows.memberB.input.row.firmName);
  await expect(details).toContainText('Suggested label basis: retained name');await expect(details).toContainText('CDLA-Permissive-2.0');await expect(details).toContainText('Feedback applies only to this observation');
  await row(page,id).getByText('Observed name, sources and details',{exact:true}).click();
 }
 await expect(row(page,rows.nonCompany.id)).toContainText('non company');await expect(row(page,rows.memberA.id)).toContainText('Phone unknown · not extracted');
 await expect(row(page,rows.absent.id)).toContainText('Phone absent · retained source explicitly declares absent');await expect(row(page,rows.conflicting.id)).toContainText('Phone conflicting · no number selected');
 await expect(row(page,rows.observedId)).toContainText('Phone +12145550123 · observed, not call-ready');
 await row(page,rows.observedId).getByText('Observed name, sources and details',{exact:true}).click();const provenance=row(page,rows.observedId).getByRole('list',{name:'Retained phone provenance'});
 for(const text of [rows.source.url,rows.source.retrievedAt,rows.observedRun,rows.source.id,'phone-0'])await expect(provenance).toContainText(text);
 await expect(row(page,rows.unsafe.id).getByRole('heading')).toHaveText('<img src=x onerror=alert(1)> Retained raw title');await expect(queue(page).getByRole('img')).toHaveCount(0);await expect(queue(page).locator('a[href^="javascript:"]')).toHaveCount(0);
 const first=await refresh(page);expect(first.prospects.find(p=>p.candidateId===rows.observedId)?.phoneEvidence?.state).toBe('observed');expect(first.prospects.every(p=>p.contactAuthority==='not_granted'&&p.qualification==='unverified')).toBe(true);
 await page.setViewportSize({width:390,height:844});await expect(row(page,rows.observedId).getByRole('button',{name:'Keep',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await queue(page).getByRole('button',{name:'Next prospect page',exact:true}).click();await expect(queue(page).getByRole('article')).toHaveCount(4);await expect(row(page,rows.memberA.id)).toHaveCount(0);
});
test('NEW767 exact visible member feedback coalesces doubleclick, persists and reconciles original UUID without group-wide state',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);const commands:unknown[]=[];
 page.on('request',request=>{if(request.url().endsWith(`/browser/api${feedback}`))commands.push(request.postDataJSON());});
 let held:string|null=null;await page.route(`**/browser/api${feedback}`,async route=>{held=await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY);await route.continue();},{times:1});
 await row(page,rows.memberB.id).getByRole('button',{name:'Keep',exact:true}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
 await expect(row(page,rows.memberB.id)).toContainText('Manual state kept');expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({candidateId:rows.memberB.id,expectedRevision:1,state:'kept'});expect(held).not.toBeNull();
 await expect(row(page,rows.memberA.id)).toContainText('Manual state new');expect((await app.fixture.db.query('SELECT candidate_id,state FROM sourcing_manual_prospect_states')).rows).toEqual([{candidate_id:rows.memberB.id,state:'kept'}]);
 await page.reload();await ready(page);await expect(row(page,rows.memberB.id)).toContainText('Manual state kept');
 await page.route(`**/browser/api${feedback}`,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await row(page,rows.memberB.id).getByRole('button',{name:'Skip',exact:true}).click();await expect(queue(page).getByRole('button',{name:'Reconcile same manual feedback'})).toBeEnabled();
 const original=commands[1];await queue(page).getByRole('button',{name:'Reconcile same manual feedback'}).click();await expect(queue(page).getByRole('button',{name:'Reconcile same manual feedback'})).toHaveCount(0);expect(commands).toHaveLength(3);expect(commands[2]).toEqual(original);await expect(row(page,rows.memberB.id)).toContainText('Manual state skipped');
 const stale=await browserRequest(page,feedback,{body:{candidateId:rows.memberB.id,expectedRevision:2,state:'kept',commandId:randomUUID()}});expect(stale).toMatchObject({status:200,body:{status:'refused',reason:'candidate_changed'}});
});
test('NEW767 optional source-loss fence removes only enrichment, and post-wait logout cannot restore private queue or phones',async({researchPage:page})=>{
 await loginManual(page,app);await ready(page);await expect(row(page,rows.observedId)).toContainText('+12145550123');
 const f=app.fixture,runtime=await f.database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 await withTransaction(runtime,()=>rememberExpiredManualSources(ctx,[rows.source.url]));const answer=await refresh(page);
 expect(answer.prospects.find(p=>p.candidateId===rows.observedId)).toMatchObject({observedPhone:null,phoneEvidence:{state:'not_extracted'}});await expect(row(page,rows.observedId)).toContainText('Phone unknown · not extracted');await expect(queue(page).getByRole('article')).toHaveCount(50);
 const second=await page.context().newPage();await second.goto(app.origin);await expect(second.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 let release=()=>{},reached=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{reached=resolve;});
 await page.route(`**/browser/api${read}`,async route=>{const response=await route.fetch();reached();await held;await route.fulfill({response});},{times:1});await queue(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();await seen;
 const delivered=page.waitForResponse(response=>response.url().endsWith(`/browser/api${read}`));try{await second.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();}finally{release();}
 await delivered;await expect(queue(page)).toHaveCount(0);expect(await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY)).toBeNull();await second.close();
});
