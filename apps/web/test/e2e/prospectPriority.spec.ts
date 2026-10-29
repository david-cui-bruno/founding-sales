import {randomUUID} from 'node:crypto';
import type {Page} from 'playwright/test';
import {mkdir} from 'node:fs/promises';
import {prospectPriorityListSchema,prospectPriorityLearningSchema} from '@fss/contracts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {browserRequest} from '../support/browser.ts';
import {startManualProspectApp,type ManualProspectApp} from '../support/manualProspectApp.ts';
import {seedManualProspects,manualProductSnapshot,routeManualProvider} from '../support/manualProspectSeed.ts';
import {inspectManualProspect} from '../support/manualProspectInspector.ts';

const prefix='/sourcing/candidates/prospects/priority';
let app:ManualProspectApp;
test.beforeAll(async()=>{app=await startManualProspectApp('848');await seedManualProspects(app);});
test.afterAll(async()=>app?.stop());
async function openRetained(page:Page):Promise<void>{
 await page.getByRole('button',{name:'Browse retained prospects',exact:true}).click();
 await page.getByRole('button',{name:'Retained review',exact:true}).click();
}
async function login(page:Page,who:'alpha'|'beta'|'sales'='alpha'):Promise<void>{
 const workspace=who==='beta'?app.fixture.beta:app.fixture.alpha;
 app.chooseIdentity(who==='sales'?workspace.salesperson:workspace.admin);
 await page.goto(app.origin);
 await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();
 // Initial access reconciliation may clear the form; wait before entering identity.
 await expect(page.getByText('Checking browser session…',{exact:true})).toHaveCount(0);
 await page.getByLabel('Workspace ID',{exact:true}).fill(workspace.workspaceId);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 if(who!=='sales')await openRetained(page);
}

test('signed current browser reviews, selects and reloads without contact or source mutation',async({researchPage:page})=>{
 await routeManualProvider(page,app);await login(page);
 const panel=page.getByRole('region',{name:'Manual prospect worklist',exact:true});
 await expect(panel.getByRole('table')).toBeVisible();
 const baseline=await manualProductSnapshot(app);
 const initial=prospectPriorityListSchema.parse((await browserRequest(page,`${prefix}/list`,{body:{state:'all',offset:0}})).body);
 expect(initial.prospects).toHaveLength(50);expect(initial.hasMore).toBe(true);
 const first=initial.prospects[0]!;expect(first.priority).toMatchObject({fit:'unknown',roleState:'unknown',consideredCount:0});
 await inspectManualProspect(page,first.prospect.candidateId);
 const review=panel.getByRole('region',{name:'Prospect priority review'});
 await expect(review.getByText('Ordinary prospect · intent unknown',{exact:true})).toBeVisible();
 await review.getByText('Review priority',{exact:true}).click();
 await review.getByRole('combobox',{name:'Residential-management fit',exact:true}).selectOption('positive');
 await review.getByRole('combobox',{name:'Potential operating value',exact:true}).selectOption('positive');
 await review.getByRole('button',{name:'Save priority assessment',exact:true}).click();
 await expect(panel.getByRole('region',{name:'Prospect priority review'}).getByText('Supported reasons to prioritize',{exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();await openRetained(page);await expect(panel.getByRole('table')).toBeVisible();
 await inspectManualProspect(page,first.prospect.candidateId);
 await panel.getByRole('region',{name:'Prospect priority review'}).getByRole('button',{name:'Select for research',exact:true}).click();
 await expect.poll(async()=>{
  const result=prospectPriorityLearningSchema.parse((await browserRequest(page,`${prefix}/learning`,{body:{from:'2020-01-01T00:00:00.000Z',to:'2099-01-01T00:00:00.000Z'}})).body);
  return {considered:result.considered,selected:result.selected};
 }).toEqual({considered:1,selected:1});
 const report=prospectPriorityLearningSchema.parse((await browserRequest(page,`${prefix}/learning`,{body:{from:'2020-01-01T00:00:00.000Z',to:'2099-01-01T00:00:00.000Z'}})).body);
 expect(report).toMatchObject({paidAdoption:'unavailable',retention:'unavailable',observations:{conversation:0,no_answer:0}});
 expect(await manualProductSnapshot(app)).toEqual(baseline);
 const context=await browserRequest(page,'/sourcing/candidates/prospects/list',{body:{state:'all',offset:0,candidateId:first.prospect.candidateId,expectedRevision:first.prospect.revision}});
 expect(context).toMatchObject({status:200,body:{prospects:[{candidateId:first.prospect.candidateId,qualification:'unverified',contactAuthority:'not_granted'}]}});
 const evidence=process.env['FSS_PRIORITY_VISUAL_DIR'];
 if(evidence){
  await mkdir(evidence,{recursive:true});await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:`${evidence}/priority-desktop.png`,fullPage:false});
  await panel.getByRole('region',{name:'Prospect priority review'}).screenshot({path:`${evidence}/priority-inspector.png`});
  await page.setViewportSize({width:390,height:844});await panel.getByRole('button',{name:'Focus',exact:true}).click();
  await panel.getByRole('region',{name:'Prospect priority review'}).scrollIntoViewIfNeeded();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`${evidence}/priority-mobile.png`,fullPage:false});
 }
});

test('changed order refuses stale pagination and browser refresh recovers explicitly',async({researchPage:page})=>{
 await routeManualProvider(page,app);await login(page);
 const initial=prospectPriorityListSchema.parse((await browserRequest(page,`${prefix}/list`,{body:{state:'all',offset:0}})).body);
 const next=prospectPriorityListSchema.parse((await browserRequest(page,`${prefix}/list`,{body:{state:'all',offset:50,viewRevision:initial.viewRevision}})).body);
 expect(next.prospects.length).toBeGreaterThan(0);
 expect(next.prospects.some(row=>initial.prospects.some(previous=>previous.prospect.candidateId===row.prospect.candidateId))).toBe(false);
 const chosen=initial.prospects.find(row=>row.priority.assessmentRevision===0)!;
 const changed=await browserRequest(page,`${prefix}/consider`,{body:{candidateId:chosen.prospect.candidateId,expectedCandidateRevision:chosen.prospect.revision,expectedAssessmentRevision:0,disposition:'considered',commandId:randomUUID()}});
 expect(changed).toMatchObject({status:200,body:{status:'accepted'}});
 expect(await browserRequest(page,`${prefix}/list`,{body:{state:'all',offset:50,viewRevision:initial.viewRevision}})).toMatchObject({status:200,body:{error:'view_changed'}});
 const panel=page.getByRole('region',{name:'Manual prospect worklist',exact:true});
 await panel.getByRole('button',{name:'Next prospect page',exact:true}).click();
 await expect(panel.getByText('Prospect order changed. Refresh from the first page to continue with current evidence.',{exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'Refresh retained worklist',exact:true}).click();await expect(panel.getByRole('table')).toBeVisible();
});

test('principal change clears priority and only current workspace can read or annotate',async({researchPage:page})=>{
 await routeManualProvider(page,app);await login(page,'beta');
 const current=prospectPriorityListSchema.parse((await browserRequest(page,`${prefix}/list`,{body:{state:'all',offset:0}})).body);
 expect(current.prospects).toHaveLength(1);expect(current.prospects[0]?.priority.consideredCount).toBe(0);
 await page.getByRole('button',{name:'Sign out',exact:true}).click();
 await expect(page.getByRole('region',{name:'Prospect priority review'})).toHaveCount(0);
 await login(page,'sales');
 expect((await browserRequest(page,`${prefix}/list`,{body:{state:'all',offset:0}})).status).toBe(403);
 await expect(page.getByRole('region',{name:'Manual prospect worklist',exact:true})).toHaveCount(0);
});
