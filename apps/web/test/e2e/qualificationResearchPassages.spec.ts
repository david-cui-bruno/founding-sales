import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {mkdir} from 'node:fs/promises';
import type {Page} from 'playwright/test';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {finishQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '@fss/domain/sourcing/qualificationStore.ts';
import {evaluateQualification} from '@fss/domain/sourcing/qualificationDecision.ts';
import {test,expect,startQualifiedResearchApp,routeQualifiedResearchProvider} from '../support/qualifiedResearchApp.ts';

let owned:Awaited<ReturnType<typeof startQualifiedResearchApp>>,candidateId:string;
const runId=randomUUID(),observationId=randomUUID(),captured=new Date().toISOString();
const companyName='Synthetic Residential Manager',website='https://research.example.test/';
const phone='Call us at: 401-555-0123',person=`Each week, ${companyName} owner Solana Reed hosts a local podcast.`;
const geography=`${companyName} manages residential properties in Providence, Rhode Island.`;
const tables=['sourcing_candidates','sourcing_qualification_runs','sourcing_admissions','provider_reservations','jobs','firms','contacts','sequence_enrollments','outbound_messages'];
async function state(){const result:Record<string,unknown>={};for(const table of tables)result[table]=(await owned.app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;}
async function openInventory(page:Page){await page.getByRole('button',{name:'Prospects',exact:true}).click();await page.getByRole('button',{name:'Source inventory',exact:true}).click();}
async function login(page:Page){
 owned.app.chooseIdentity(owned.app.fixture.alpha.admin);await page.goto(owned.app.origin);
 await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();
 await expect(page.getByText('Checking browser session…',{exact:true})).toHaveCount(0);
 await page.getByLabel('Workspace ID',{exact:true}).fill(owned.app.fixture.alpha.workspaceId);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();await openInventory(page);
}
test.beforeAll(async()=>{
 assert.equal(process.env['FSS_RESEARCH_PASSAGES_EXCLUSIVE_LANE'],'issue797-retained-context','Root sole disposable PG/Chrome lane grant required');
 owned=await startQualifiedResearchApp();const f=owned.app.fixture;
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),f.db);
 const saved=await withTransaction(f.db,()=>saveCandidate(ctx,{firmName:companyName,website,locality:'Providence',region:'RI',signal:'fit_only',evidence:geography,sourceUrl:website,observedOn:captured.slice(0,10),preparedBy:'Controlled retained research context'}));
 assert(saved.ok);candidateId=saved.value.id;
 await f.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name)
 VALUES($1,$2,$3,1,$4,$5,$6,'controlled-no-provider-fixture')`,[f.alpha.workspaceId,runId,candidateId,'f'.repeat(64),QUALIFICATION_PROMPT_VERSION,QUALIFICATION_POLICY_VERSION]);
 const finished=await withTransaction(f.db,()=>finishQualification(ctx,{runId,reason:null,
  observations:[{id:observationId,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:captured,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,
   blocks:[{id:'p1',text:phone},{id:'r1',text:person},{id:'g1',text:geography},{id:'l1',text:companyName},{id:'l2',text:'Pawtucket RI Office'},{id:'l3',text:'49 Example Street Pawtucket RI 02860'}]}],
  facts:[{kind:'firm_identity',observationId,blockId:'l1',value:companyName},{kind:'service_area',observationId,blockId:'g1',value:geography},{kind:'residential_management',observationId,blockId:'g1',value:geography},{kind:'business_phone',observationId,blockId:'p1',value:phone}]}));
 assert(finished.ok);assert((await withTransaction(f.db,()=>evaluateQualification(ctx,{runId}))).ok);
});
test.afterAll(async()=>{await owned?.stop();});

test('signed retained read surfaces research clues, separates office from area and preserves all write/qualification boundaries',async({researchPage:page})=>{
 await routeQualifiedResearchProvider(page,owned.app);const external:string[]=[],mutations:string[]=[];
 page.on('request',request=>{const url=new URL(request.url());if(url.origin!==owned.app.origin)external.push(url.origin);if(/\/sourcing\/(?:qualification\/(?:request|admit)|candidates\/(?:save|correct-name|check|review|delete))$/u.test(url.pathname))mutations.push(url.pathname);});
 await login(page);expect(owned.app.fixture.google.jwksFetches()).toBeGreaterThan(0);
 const before=await state();const inventory=page.getByRole('region',{name:'Ordinary sourcing inventory',exact:true});
 await inventory.getByRole('button',{name:'Load ordinary inventory',exact:true}).click();
 const card=inventory.getByRole('article',{name:`Candidate ${candidateId}`,exact:true});
 await expect(card).toContainText('Observed area Providence · Region RI. Office location may differ.');
 await card.getByRole('button',{name:'Read qualification',exact:true}).click();
 await expect(card).toContainText('Unknown business_phone_unresolved');await expect(card).toContainText('Unknown maintenance_need_unconfirmed');
 const context=card.locator('details').filter({has:page.getByText('Phone, people and office context',{exact:true})});
 await context.locator('summary').click();
 await expect(context.getByText(person,{exact:true}).first()).toBeVisible();await expect(context.getByText('Pawtucket RI Office',{exact:true}).first()).toBeVisible();await expect(context.getByText(phone,{exact:true}).first()).toBeVisible();
 await expect(context).toContainText('Original block');await expect(context).toContainText(website);await expect(context.locator('a,button,input')).toHaveCount(0);
 await expect(card.getByRole('button',{name:'Admit reviewed qualification',exact:true})).toHaveCount(0);
 const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain(person);expect(storage).not.toContain(phone);
 const evidence=process.env['FSS_RESEARCH_PASSAGES_VISUALS'];
 if(evidence){await mkdir(evidence,{recursive:true});await context.screenshot({path:join(evidence,'research-context-desktop.png')});}
 await page.setViewportSize({width:390,height:844});
 await expect(context.getByText(person,{exact:true}).first()).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 if(evidence)await page.screenshot({path:join(evidence,'research-context-mobile.png'),fullPage:true});
 await page.reload();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();await openInventory(page);await inventory.getByRole('button',{name:'Load ordinary inventory',exact:true}).click();await card.getByRole('button',{name:'Read qualification',exact:true}).click();
 await expect(context).not.toHaveAttribute('open','');await context.locator('summary').click();await expect(context.getByText(person,{exact:true}).first()).toBeVisible();
 await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('button',{name:'Sign in',exact:true})).toBeVisible();await expect(page.getByText(person,{exact:true})).toHaveCount(0);
 expect(await state()).toEqual(before);expect(mutations).toEqual([]);expect(external).toEqual([]);
});
