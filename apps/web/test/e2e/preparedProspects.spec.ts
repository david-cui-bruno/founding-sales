import {mkdir} from 'node:fs/promises';
import type {Page} from 'playwright/test';
import {preparedProspectBriefSchema,preparedProspectListSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {seedPreparedProspect,preparedProspectsBusinessSnapshot} from '../../../../packages/domain/test/sourcing/preparedProspectsPgFixture.ts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {browserRequest} from '../support/browser.ts';
import {startManualProspectApp,type ManualProspectApp} from '../support/manualProspectApp.ts';
import {routeManualProvider} from '../support/manualProspectSeed.ts';

let app:ManualProspectApp,fixture:Awaited<ReturnType<typeof seedPreparedProspect>>;
const context=async()=>repositoryContext(workspaceScope(app.fixture.alpha.workspaceId,{kind:'user',userId:app.fixture.alpha.admin.userId,role:'admin'}),await app.fixture.database.appRuntimeSession());
async function login(page:Page,who:'alpha'|'beta'|'sales'='alpha'){
 const workspace=who==='beta'?app.fixture.beta:app.fixture.alpha;app.chooseIdentity(who==='sales'?workspace.salesperson:workspace.admin);
 await page.goto(app.origin);await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();
 await expect(page.getByText('Checking browser session…',{exact:true})).toHaveCount(0);
 await page.getByLabel('Workspace ID',{exact:true}).fill(workspace.workspaceId);await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
}
// 848 selects the existing allocator adapter only; this new acceptance is #797.
test.beforeAll(async()=>{app=await startManualProspectApp('848');const ctx=await context();fixture=await seedPreparedProspect(ctx);await seedPreparedProspect(ctx,2,{pages:false});});
test.afterAll(async()=>app?.stop());

test('signed administrator opens the default prepared view and a useful source-backed brief, then reloads without business writes',async({researchPage:page})=>{
 await routeManualProvider(page,app);await page.setViewportSize({width:1440,height:1000});
 const before=await preparedProspectsBusinessSnapshot(await context());
 await login(page);
 await page.getByRole('button',{name:'Prospects',exact:true}).click();
 await expect(page.getByRole('button',{name:'Prepared research',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('heading',{name:'Prepared companies',exact:true})).toBeVisible();
 const response=await browserRequest(page,'/sourcing/prepared-prospects/list',{body:{offset:0}});expect(response).toMatchObject({status:200});
 const initial=preparedProspectListSchema.parse(response.body);expect(initial.prospects).toHaveLength(2);
 const selected=initial.prospects.find(row=>row.target.candidateId===fixture.candidateId)!;expect(selected.state).toBe('prepared');
 await page.getByRole('button',{name:`Open company brief for ${selected.displayName}`,exact:true}).click();
 const brief=page.getByRole('article',{name:'Prepared company brief'});await expect(brief).toBeVisible();
 await expect(brief.getByText(`${fixture.name} manages residential homes in Boston, Massachusetts.`,{exact:true})).toBeVisible();
 await expect(brief.getByText('Research context only.',{exact:false})).toBeVisible();
 const read=await browserRequest(page,'/sourcing/prepared-prospects/read',{body:selected.target});expect(read.status).toBe(200);
 expect(preparedProspectBriefSchema.parse(read.body)).toMatchObject({target:selected.target,contactAuthority:'not_granted'});
 await brief.getByText('Source and record details',{exact:true}).click();await expect(brief.getByText(new RegExp(fixture.observations[0]!.id,'u')).first()).toBeVisible();
 await brief.getByText('Source and record details',{exact:true}).click();
 const screenshot=process.env['FSS_PREPARED_PROSPECTS_SCREENSHOTS'];if(screenshot){await mkdir(screenshot,{recursive:true});await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();scrollTo(0,0);});await page.screenshot({path:`${screenshot}/prepared-company-desktop.png`,fullPage:true});}
 await page.setViewportSize({width:390,height:844});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 if(screenshot){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${screenshot}/prepared-company-mobile.png`,fullPage:true});}
 await page.getByRole('button',{name:'Back to companies',exact:true}).click();await page.getByRole('button',{name:'Refresh companies',exact:true}).click();
 await expect(page.getByRole('button',{name:`Open company brief for ${selected.displayName}`,exact:true})).toBeVisible();
 expect(await preparedProspectsBusinessSnapshot(await context())).toEqual(before);expect(app.runtimeRequests()).toBeGreaterThan(0);
 await page.reload();await page.getByRole('button',{name:'Prospects',exact:true}).click();await expect(page.getByRole('heading',{name:'Prepared companies',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Qualified publications',exact:true}).click();
 await expect(page.getByRole('region',{name:'Prepared source-backed supply',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Prepared company research',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Prepared research',exact:true}).click();
 await expect(page.getByRole('button',{name:`Open company brief for ${selected.displayName}`,exact:true})).toBeVisible();
 expect(await preparedProspectsBusinessSnapshot(await context())).toEqual(before);
});

test('signed foreign workspace cannot read the retained target and salesperson cannot access the prepared API',async({researchPage:page})=>{
 await routeManualProvider(page,app);await login(page,'beta');
 expect(await browserRequest(page,'/sourcing/prepared-prospects/read',{body:{candidateId:fixture.candidateId,candidateRevision:1,runId:fixture.runId}})).toMatchObject({status:200,body:{error:'candidate_unavailable'}});
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await login(page,'sales');
 const denied=await browserRequest(page,'/sourcing/prepared-prospects/list',{body:{offset:0}});expect(denied.status).toBe(403);expect(JSON.stringify(denied.body)).not.toContain(fixture.name);
});
