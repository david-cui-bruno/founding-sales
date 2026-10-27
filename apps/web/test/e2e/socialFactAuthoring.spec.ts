import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveSocialVoicePreferences} from '@fss/domain/social/voicePreferences.ts';
import {test,expect} from '../support/qualifiedResearchApp.ts';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {routeManualProvider} from '../support/manualProspectSeed.ts';
import {socialProductSnapshot} from '../support/socialReviewSeed.ts';
const first='A bounded local fact editor is planned.';
const revised='A bounded local fact editor with explicit version approval is planned.';
let app:Awaited<ReturnType<typeof startManualProspectApp>>;
let baseline:Record<string,unknown[]>;
async function snapshot(){const value=await socialProductSnapshot(app);for(const key of ['command_receipts','audit_events'])delete value[key];return value;}
// Authored acceptance only. Do not execute without a fresh Root grant for the
// existing exclusive 773 PG16/UTF8, HTTPS/OIDC and installed-Chrome resources.
// No worker, fake/real model, provider adapter or source acquisition is run.
test.beforeAll(async()=>{
 app=await startManualProspectApp('773');
 expect((await app.fixture.db.query('SHOW server_encoding')).rows[0]?.['server_encoding']).toBe('UTF8');
 const version=Number((await app.fixture.db.query('SHOW server_version_num')).rows[0]?.['server_version_num']);expect(version).toBeGreaterThanOrEqual(160000);expect(version).toBeLessThan(170000);
 baseline=await snapshot();
});
test.afterAll(async()=>{try{if(app&&baseline)expect(await snapshot()).toEqual(baseline);}finally{await app?.stop();}});
test('signed navigation authors two versions, separately approves exact v2 and prepares that same fact',async({researchPage:page})=>{
 const f=app.fixture,runtime=await f.database.appRuntimeSession();
 expect((await runtime.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime');
 const ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 // Only the guide is seeded through its existing owner. All facts and their
 // approvals must be authored through the mounted signed browser below.
 const guide=await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx,{operation:'create',entries:[{entryId:randomUUID(),dimension:'tone',guidance:'Use precise neutral sentences.'}]},async()=>true));assert(guide.ok);
 await routeManualProvider(page,app);
 await page.goto(app.origin);await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();await expect(page.getByText('Checking browser session…',{exact:true})).toHaveCount(0);
 await page.getByLabel('Workspace ID',{exact:true}).fill(f.alpha.workspaceId);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 const social=async()=>{await page.getByRole('navigation',{name:'Workspace sections',exact:true}).getByRole('button',{name:'Social',exact:true}).click();};
 await social();await page.getByRole('button',{name:'Author shared facts',exact:true}).click();
 const facts=page.getByRole('region',{name:'Social fact authoring',exact:true}),generation=page.getByRole('region',{name:'Guided social suggestion request',exact:true});
 const read=async()=>{await facts.getByRole('button',{name:'Read current facts',exact:true}).click();await expect(facts).toContainText('Current shared facts read.');await expect(facts.getByRole('button',{name:'Read current facts',exact:true})).toBeEnabled();};
 await read();await facts.getByRole('textbox',{name:'Answer fact',exact:true}).fill(first);await facts.getByLabel('Sanitized LinkedIn factual input',{exact:true}).check();await facts.getByRole('button',{name:'Save fact draft',exact:true}).click();await expect(facts).toContainText('version 1 saved unapproved');
 const parent=(await f.db.query<{id:string;current_version:number}>('SELECT id,current_version FROM outreach_answer_blocks WHERE workspace_id=$1',[f.alpha.workspaceId])).rows;expect(parent).toHaveLength(1);const id=parent[0]!.id;expect(parent[0]!.current_version).toBe(1);
 const versions=async()=>(await f.db.query('SELECT version,text,approved_at IS NOT NULL AS approved,retired_at IS NOT NULL AS retired FROM outreach_answer_block_versions WHERE workspace_id=$1 AND block_id=$2 ORDER BY version',[f.alpha.workspaceId,id])).rows;
 expect(await versions()).toEqual([{version:1,text:first,approved:false,retired:false}]);
 // Exact label-text matching also includes React's textarea default text after
 // editing. Use its stable accessible textbox name, not descendant label text.
 await read();await facts.getByRole('button',{name:'Edit fact',exact:true}).click();await facts.getByRole('textbox',{name:'Answer fact',exact:true}).fill(revised);await facts.getByRole('button',{name:'Save fact draft',exact:true}).click();await expect(facts).toContainText('version 2 saved unapproved');
 expect(await versions()).toEqual([{version:1,text:first,approved:false,retired:false},{version:2,text:revised,approved:false,retired:false}]);
 // A saved but unapproved version cannot be selected for preparation.
 await generation.getByRole('button',{name:'Read current generation inputs',exact:true}).click();await expect(generation).toContainText('No current approved social facts.');await expect(generation.getByRole('button',{name:'Request guided social suggestion',exact:true})).toBeDisabled();
 await read();await facts.getByRole('button',{name:'Approve exact text',exact:true}).click();await expect(facts).toContainText(`Fact ${id} version 2 approved`);
 expect(await versions()).toEqual([{version:1,text:first,approved:false,retired:false},{version:2,text:revised,approved:true,retired:false}]);
 await read();await expect(facts).toContainText('Current · Approved · version 2');
 await generation.getByRole('button',{name:'Read current generation inputs',exact:true}).click();await generation.getByRole('checkbox',{name:/Use saved voice guide/u}).check();await generation.getByRole('checkbox',{name:new RegExp(`Fact ${id} version 2`,'u')}).check();await generation.getByRole('button',{name:'Request guided social suggestion',exact:true}).click();await expect(generation).toContainText('Current request queued');
 const requests=(await f.db.query('SELECT state,paid_attempts,concepts,source_selection FROM social_draft_requests WHERE workspace_id=$1',[f.alpha.workspaceId])).rows;expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({state:'queued',paid_attempts:0,concepts:null,source_selection:{factBlocks:[{id,version:2}],voiceGuideRef:guide.value}});
 await page.reload();await social();await page.getByRole('button',{name:'Author shared facts',exact:true}).click();await read();await expect(facts).toContainText(revised);await expect(facts).toContainText('Current · Approved · version 2');
 expect((await f.db.query('SELECT id,current_version FROM outreach_answer_blocks WHERE workspace_id=$1',[f.alpha.workspaceId])).rows).toEqual([{id,current_version:2}]);
 expect(await snapshot()).toEqual(baseline);expect(app.runtimeRequests()).toBeGreaterThan(0);expect(f.google.jwksFetches()).toBeGreaterThan(0);
 expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(revised);
});
