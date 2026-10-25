import type {Page} from 'playwright/test';
import {manualProspectListSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '@fss/domain/sourcing/discoveryIntake.ts';
import {manualOrdinaryFixture,manualDiscoveryFixture} from '../../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import {manualLiteralPhoneFixture,seedManualPhoneRun} from '../../../../packages/domain/test/sourcing/support/manualPhoneFixture.ts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {manualProductSnapshot,routeManualProvider,loginManual} from '../support/manualProspectSeed.ts';
import {browserSession} from '../support/browser.ts';
const read='/browser/api/sourcing/candidates/prospects/list';
let app:Awaited<ReturnType<typeof startManualProspectApp>>,single:string,conflict:string,missing:string,absent:string,run:string,baseline:Awaited<ReturnType<typeof manualProductSnapshot>>;
const panel=(page:Page)=>page.getByRole('region',{name:'Manual prospect worklist',exact:true});
const card=(page:Page,id:string)=>panel(page).getByRole('article',{name:`Manual prospect ${id}`,exact:true});
async function refresh(page:Page){const response=page.waitForResponse(value=>value.url().endsWith(read));await panel(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();const result=await response;expect(result.status()).toBe(200);return manualProspectListSchema.parse(await result.json());}
async function seed(){
 const f=app.fixture,runtime=await f.database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 for(const [index,texts] of [[775,['🏡 Main phone: (214) 555-0123']],[776,['Phone: 2145550123','Tel: 555-0124']],[777,['No endpoint captured']]] as const){
  const input=manualOrdinaryFixture(index);input.website='https://source.example.test/';const saved=await withTransaction(runtime,()=>saveCandidate(ctx,input));if(!saved.ok)throw Error(saved.reason);
  const id=await seedManualPhoneRun(f.db,f.alpha.workspaceId,saved.value.id,manualLiteralPhoneFixture(input.sourceUrl,[...texts]));
  if(index===775){single=saved.value.id;run=id;}else if(index===776)conflict=saved.value.id;else missing=saved.value.id;
 }
 const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx,manualDiscoveryFixture('literal-absent-775')));if(!saved.ok)throw Error(saved.reason);absent=saved.value.id;
 // Synthetic pre-existing source declaration, not a runtime intake claim or a
 // parser-invented absence. Production raw intake cannot assert this state.
 await f.db.query(`UPDATE sourcing_candidates SET payload=jsonb_set(payload,'{row,officePhoneEvidence}','"absent"') WHERE id=$1`,[absent]);
}
test.beforeAll(async()=>{app=await startManualProspectApp('775');await seed();baseline=await manualProductSnapshot(app);});
test.afterAll(async()=>{try{if(app&&baseline)expect(await manualProductSnapshot(app)).toEqual(baseline);}finally{await app?.stop();}});
test.beforeEach(async({researchPage:page})=>{
 await routeManualProvider(page,app);page.on('request',request=>{
  const url=new URL(request.url());expect(url.origin).toBe(app.origin);
  if(url.pathname.startsWith('/browser/api/'))expect(['/browser/api/today','/browser/api/today/actions/v4','/browser/api/sourcing/research-firms/list',read,'/browser/api/sourcing/candidates/prospects/feedback']).toContain(url.pathname);
 });
});
test.afterEach(async({researchPage:page})=>{
 expect(await manualProductSnapshot(app)).toEqual(baseline);
 const stored=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(stored).not.toMatch(/12145550123|\(214\) 555|Main phone|literal-absent|contentHash|source\.example/u);
});
test('775 actual signed runtime browser shows all four honest phone states with exact original span and no acquisition',async({researchPage:page})=>{
 await loginManual(page,app);await expect(panel(page).getByRole('article')).toHaveCount(4);
 const list=await refresh(page),row=list.prospects.find(value=>value.candidateId===single)!;
 expect(row).toMatchObject({qualification:'unverified',contactAuthority:'not_granted',phoneEvidence:{state:'observed',coverage:{state:'complete'},sources:[{method:'retained_original_literal',literal:'(214) 555-0123',start:15,end:29,label:'Main phone',lineage:{kind:'provider_original'}}]}});
 expect(list.prospects.find(value=>value.candidateId===conflict)?.phoneEvidence?.state).toBe('conflicting');expect(list.prospects.find(value=>value.candidateId===missing)?.phoneEvidence?.state).toBe('not_extracted');expect(list.prospects.find(value=>value.candidateId===absent)?.phoneEvidence?.state).toBe('absent');
 await card(page,single).getByText('Observed name, sources and details',{exact:true}).click();await expect(card(page,single)).toContainText('Retained original literal: (214) 555-0123');await expect(card(page,single)).toContainText('UTF-16 span [15, 29)');await expect(card(page,single)).toContainText('formatting assumption');await expect(card(page,single).locator('a[href^="tel:"]')).toHaveCount(0);
 const feedback=page.waitForResponse(value=>value.url().endsWith('/prospects/feedback'));await card(page,missing).getByRole('button',{name:'Keep',exact:true}).click();expect(await (await feedback).json()).toMatchObject({status:'accepted',result:{candidateId:missing,state:'kept'}});
 await page.reload();await expect(card(page,missing)).toContainText('Manual state kept');await expect(card(page,single)).toContainText('Phone +12145550123');
 expect(app.runtimeRequests()).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);expect(app.fixture.google.tokenExchanges().at(-1)?.clientSecretPresented).toBe(true);
});
test('775 optional original loss removes phone but leaves the same raw prospect and actions without stale content',async({researchPage:page})=>{
 await loginManual(page,app);await expect(card(page,single)).toContainText('Phone +12145550123');
 const retained=(await app.fixture.db.query('SELECT observations FROM sourcing_qualification_runs WHERE id=$1',[run])).rows[0]?.['observations'];
 try{
  await app.fixture.db.query("UPDATE sourcing_qualification_runs SET observations='[]' WHERE id=$1",[run]);
  const before=await manualProductSnapshot(app);const list=await refresh(page);expect(list.prospects.find(value=>value.candidateId===single)).toMatchObject({observedPhone:null,phoneEvidence:{state:'not_extracted'}});
  await expect(card(page,single)).toContainText('Phone unknown');await expect(card(page,single)).not.toContainText('(214) 555-0123');await expect(card(page,single).getByRole('button',{name:'Wrong number',exact:true})).toBeEnabled();expect(await manualProductSnapshot(app)).toEqual(before);
 }finally{await app.fixture.db.query('UPDATE sourcing_qualification_runs SET observations=$2 WHERE id=$1',[run,JSON.stringify(retained)]);}
});
test('775 current session revoked during real source lifecycle lock wait refuses phone read and clears private queue',async({researchPage:page})=>{
 await loginManual(page,app);await expect(card(page,single)).toContainText('Phone +12145550123');const session=await browserSession(page);if(session.status!=='signed_in')throw Error('Signed session required');
 const blocker=await app.fixture.database.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${app.fixture.alpha.workspaceId}`]);
 const response=page.waitForResponse(value=>value.url().endsWith(read));await panel(page).getByRole('button',{name:'Refresh retained worklist',exact:true}).click();
 try{
  await expect.poll(async()=>Number((await app.fixture.db.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'")).rows[0]?.['n'])).toBe(1);
  await app.fixture.db.query("UPDATE devices SET status='revoked',revoked_at=now() WHERE id=$1",[session.deviceId]);
 }finally{await blocker.query('ROLLBACK');}
 // Existing list authority_changed is a generic409, which BrowserClient treats
 // as authority invalidation just like401/403. Do not change the shared route.
 expect((await response).status()).toBe(409);await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();await expect(panel(page)).toHaveCount(0);expect(await page.locator('body').innerText()).not.toContain('+12145550123');
});
