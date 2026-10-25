import type {Page} from 'playwright/test';
import {manualProspectListSchema} from '@fss/contracts';
import {manualLiteralPhoneFixture,seedManualPhoneRun} from '../../../../packages/domain/test/sourcing/support/manualPhoneFixture.ts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {seedCompactManualProspects} from '../support/manualProspectCompactSeed.ts';
import {manualProductSnapshot,routeManualProvider,loginManual} from '../support/manualProspectSeed.ts';
import {browserRequest} from '../support/browser.ts';
import {MANUAL_PROSPECT_PENDING_KEY} from '../../src/client/ManualProspectPending.ts';
const read='/sourcing/candidates/prospects/list',feedback='/sourcing/candidates/prospects/feedback';
let app:Awaited<ReturnType<typeof startManualProspectApp>>,rows:Awaited<ReturnType<typeof seedCompactManualProspects>>,baseline:Awaited<ReturnType<typeof manualProductSnapshot>>;
const worklist=(page:Page)=>page.getByRole('region',{name:'Manual prospect worklist',exact:true});
const inspector=(page:Page)=>worklist(page).getByRole('region',{name:'Selected prospect inspector',exact:true});
const table=(page:Page)=>worklist(page).getByRole('table');
async function ready(page:Page){await expect(table(page).getByRole('row')).toHaveCount(51);await expect(worklist(page).getByRole('button',{name:'Refresh retained worklist',exact:true})).toBeEnabled();}
async function select(page:Page,id:string){await table(page).locator(`tr[data-candidate-id="${id}"]`).getByRole('button').click();await expect(inspector(page).getByRole('article')).toHaveAttribute('aria-label',`Manual prospect ${id}`);}
async function retained(page:Page,state='all',offset=0){const answer=await browserRequest(page,read,{body:{state,offset}});expect(answer.status).toBe(200);return manualProspectListSchema.parse(answer.body);}
async function screenshot(page:Page,name:string){
 const directory=process.env['FSS_INSPECTOR_SCREENSHOTS'];if(!directory)return;
 if(name.endsWith('focus')){await inspector(page).screenshot({path:`${directory}/${name}.png`});return;}
 await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.manual-table-scroll')?.scrollTo(0,0);});
 await page.screenshot({path:`${directory}/${name}.png`});
}
test.beforeAll(async()=>{
 app=await startManualProspectApp('779');rows=await seedCompactManualProspects(app);
 await app.fixture.db.query("UPDATE sourcing_candidates SET payload=jsonb_set(jsonb_set(payload,'{website}',$2::jsonb),'{sourceUrl}',$3::jsonb) WHERE id=$1",[rows.observedId,JSON.stringify('https://phone-source.example.test/'),JSON.stringify(rows.source.url)]);
 await seedManualPhoneRun(app.fixture.db,app.fixture.alpha.workspaceId,rows.observedId,manualLiteralPhoneFixture(rows.source.url,['Main phone: (214) 555-0123']));
 baseline=await manualProductSnapshot(app);
});
test.afterAll(async()=>{try{if(app&&baseline)expect(await manualProductSnapshot(app)).toEqual(baseline);}finally{await app?.stop();}});
test.beforeEach(async({researchPage:page})=>{
 await app.fixture.db.query('DELETE FROM sourcing_manual_prospect_states');await routeManualProvider(page,app);
 page.on('request',request=>{const url=new URL(request.url());expect(url.origin).toBe(app.origin);if(url.pathname.startsWith('/browser/api/'))expect(['/browser/api/today','/browser/api/today/actions/v4','/browser/api/sourcing/research-firms/list',`/browser/api${read}`,`/browser/api${feedback}`,'/browser/api/sourcing/candidates/prospects/activity/list']).toContain(url.pathname);});
});
test.afterEach(async({researchPage:page})=>{
 expect(await manualProductSnapshot(app)).toEqual(baseline);
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toMatch(/Boston Property|Retained raw|phone-source|12145550123|CDLA|https:/u);
});
test('779 desktop real retained list selects exact members, keeps unknown phone, persists independently, preserves literal phone after wrong-number flag, pages and focuses',async({researchPage:page})=>{
 await page.setViewportSize({width:1512,height:900});await loginManual(page,app);await ready(page);
 expect(app.runtimeRequests()).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
 const geometry=await page.evaluate(()=>({prospects:document.querySelector('#prospects')!.getBoundingClientRect().top,today:document.querySelector('#today')!.getBoundingClientRect().top,width:document.documentElement.scrollWidth,viewport:innerWidth}));expect(geometry.prospects).toBeLessThan(160);expect(geometry.prospects).toBeLessThan(geometry.today);expect(geometry.width).toBe(geometry.viewport);
 await select(page,rows.memberB.id);await expect(inspector(page)).toContainText('Phone unknown · not extracted');await expect(inspector(page).locator('details')).not.toHaveAttribute('open','');
 await inspector(page).getByText('Observed name, sources and details',{exact:true}).click();await expect(inspector(page).getByRole('list',{name:'Source licenses and notices'})).toContainText('CDLA-Permissive-2.0');await inspector(page).getByText('Observed name, sources and details',{exact:true}).click();
 expect(await inspector(page).getByRole('button',{name:'Keep',exact:true}).evaluate(button=>Number(getComputedStyle(button).fontWeight))).toBeGreaterThanOrEqual(600);
 await inspector(page).getByRole('button',{name:'Keep',exact:true}).click();await expect(inspector(page)).toContainText('Manual state kept');
 const independent=await retained(page);expect(independent.prospects.find(p=>p.candidateId===rows.memberB.id)?.state).toBe('kept');expect(independent.prospects.find(p=>p.candidateId===rows.memberA.id)?.state).toBe('new');
 expect((await app.fixture.db.query('SELECT candidate_id,state FROM sourcing_manual_prospect_states')).rows).toEqual([{candidate_id:rows.memberB.id,state:'kept'}]);
 await page.reload();await ready(page);await select(page,rows.memberB.id);await expect(inspector(page)).toContainText('Manual state kept');
 await select(page,rows.observedId);await inspector(page).getByRole('button',{name:'Wrong number',exact:true}).click();await expect(inspector(page)).toContainText('Manual flag: wrong number. Original phone evidence is unchanged.');await expect(inspector(page)).toContainText('Phone +12145550123 · observed, not call-ready');
 await inspector(page).getByText('Observed name, sources and details',{exact:true}).click();await expect(inspector(page)).toContainText('Retained original literal: (214) 555-0123');await expect(inspector(page)).toContainText('UTF-16 span [12, 26)');await expect(inspector(page)).toContainText('Default US is a formatting assumption');
 const saved=await retained(page);expect(saved.prospects.find(p=>p.candidateId===rows.observedId)).toMatchObject({state:'wrong_number',phoneEvidence:{state:'observed',value:'+12145550123'}});
 await inspector(page).getByText('Observed name, sources and details',{exact:true}).click();await screenshot(page,'779-desktop-worklist');await worklist(page).getByRole('button',{name:'Focus',exact:true}).click();await expect(table(page)).toHaveCount(0);await expect(inspector(page)).toContainText('Phone +12145550123');await screenshot(page,'779-desktop-focus');
 await worklist(page).getByRole('button',{name:'Worklist',exact:true}).click();await ready(page);
 await worklist(page).getByRole('button',{name:'Next prospect page',exact:true}).click();await expect(table(page).getByRole('row')).toHaveCount(5);await expect(worklist(page)).toContainText('Offset 50');await expect(inspector(page).getByRole('article')).toHaveCount(1);await expect(table(page).locator(`tr[data-candidate-id="${rows.memberB.id}"]`)).toHaveCount(0);expect((await retained(page,'all',50)).prospects).toHaveLength(4);
 await worklist(page).getByRole('button',{name:'Previous prospect page',exact:true}).click();await ready(page);await expect(worklist(page)).toContainText('Offset 0');
 await expect(page.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
});
test('779 narrow actual keyboard selection enters inspector, focus controls remain reachable and private activity stays bound to its original exact prospect',async({researchPage:page})=>{
 await page.setViewportSize({width:390,height:844});await loginManual(page,app);await ready(page);
 const target=table(page).locator(`tr[data-candidate-id="${rows.memberA.id}"]`).getByRole('button');await target.focus();await page.keyboard.press('Enter');await expect(table(page)).toHaveCount(0);await expect(inspector(page).getByRole('heading',{name:'Boston Property Management',exact:true})).toBeFocused();
 await page.keyboard.press('Tab');await expect(inspector(page).getByRole('link')).toBeFocused();await page.keyboard.press('Tab');await expect(inspector(page).getByRole('button',{name:'Keep',exact:true})).toBeFocused();
 await page.keyboard.press('Enter');await expect(inspector(page)).toContainText('Manual state kept');await expect(inspector(page).getByRole('heading')).toBeFocused();expect((await retained(page)).prospects.find(p=>p.candidateId===rows.memberA.id)?.state).toBe('kept');
 await inspector(page).getByRole('button',{name:'Open private manual activity',exact:true}).click();const activity=page.getByRole('region',{name:'Private manual prospect activity',exact:true});await expect(activity).toContainText('Recording places no call');
 const bound=await activity.textContent();await inspector(page).getByRole('button',{name:'Next prospect',exact:true}).click();await expect(activity).toHaveText(bound!);
 await expect(activity.getByRole('button',{name:'Record a user-performed attempt',exact:true})).toBeVisible();await worklist(page).getByRole('button',{name:'Close private manual activity',exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth)).toBe(true);await screenshot(page,'779-narrow-focus');
 await worklist(page).getByRole('button',{name:'Worklist',exact:true}).click();await ready(page);expect(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth)).toBe(true);await screenshot(page,'779-narrow-worklist');
 await page.setViewportSize({width:820,height:900});await select(page,rows.unsafe.id);await expect(inspector(page).getByRole('heading')).toHaveText('<img src=x onerror=alert(1)> Retained raw title');expect(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth)).toBe(true);await expect(worklist(page).getByRole('img')).toHaveCount(0);await expect(worklist(page).locator('a[href^="javascript:"]')).toHaveCount(0);await screenshot(page,'779-tablet-focus');
});
test('779 actual read loading, refused transport, empty state recovery and same-command UNKNOWN custody remain honest',async({researchPage:page})=>{
 await page.setViewportSize({width:1280,height:900});await loginManual(page,app);await ready(page);await select(page,rows.memberA.id);
 let release=()=>{},reached=()=>{};const held=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{reached=resolve;});
 await page.route(`**/browser/api${read}`,async route=>{const response=await route.fetch();reached();await held;await route.fulfill({response});},{times:1});
 await worklist(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();await seen;
 try{await expect(worklist(page)).toContainText('Loading manual worklist or recording feedback.');await expect(inspector(page)).toHaveCount(0);await expect(worklist(page).getByRole('button',{name:'Next prospect page',exact:true})).toBeDisabled();}finally{release();}await ready(page);
 await page.route(`**/browser/api${read}`,async route=>{await route.fetch();await route.abort('failed');},{times:1});await worklist(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();await expect(worklist(page)).toContainText('Manual worklist unavailable or refused. This is not an empty inventory.');await expect(inspector(page)).toHaveCount(0);await expect(worklist(page).getByRole('heading',{name:'No retained prospects in this view.'})).toHaveCount(0);
 await worklist(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();await ready(page);
 await worklist(page).getByRole('combobox',{name:'Manual state',exact:true}).selectOption('kept');await expect(worklist(page).getByRole('heading',{name:'No retained prospects in this view.'})).toBeVisible();await expect(table(page)).toHaveCount(0);await worklist(page).getByRole('button',{name:'Return to first page, all states',exact:true}).click();await ready(page);await select(page,rows.memberB.id);
 const commands:unknown[]=[];page.on('request',request=>{if(request.url().endsWith(`/browser/api${feedback}`))commands.push(request.postDataJSON());});
 await page.route(`**/browser/api${feedback}`,async route=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');},{times:1});
 await inspector(page).getByRole('button',{name:'Skip',exact:true}).click();await expect(worklist(page).getByRole('button',{name:'Reconcile same manual feedback'})).toBeEnabled();const bytes=await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY);expect(bytes).not.toBeNull();expect(commands).toHaveLength(1);
 await select(page,rows.memberA.id);await expect(inspector(page).getByRole('button',{name:'Keep',exact:true})).toBeDisabled();await page.reload();await ready(page);expect(commands).toHaveLength(1);expect(await page.evaluate(key=>sessionStorage.getItem(key),MANUAL_PROSPECT_PENDING_KEY)).toBe(bytes);
 await worklist(page).getByRole('button',{name:'Reconcile same manual feedback'}).click();await expect(worklist(page).getByRole('button',{name:'Reconcile same manual feedback'})).toHaveCount(0);expect(commands).toHaveLength(2);expect(commands[1]).toEqual(commands[0]);expect((await retained(page)).prospects.find(p=>p.candidateId===rows.memberB.id)?.state).toBe('skipped');
});
