import {expect,test} from '../support/qualifiedResearchApp.ts';
import type {Page} from 'playwright/test';
import {startManualProspectApp} from '../support/manualProspectApp.ts';
import {routeManualProvider} from '../support/manualProspectSeed.ts';
import {browserRequest} from '../support/browser.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {databaseNow} from '@fss/domain/policy/clock.ts';
import {retainSocialPublicThread} from '@fss/domain/social/publicThreads.ts';
import {eraseSocialPublicThreadByIdentity} from '@fss/domain/social/publicThreadRetention.ts';
import {publicThreadFixture} from '../../../../packages/domain/test/social/publicThreadFixture.ts';
let app:Awaited<ReturnType<typeof startManualProspectApp>>;
// AUTHORED ONLY. Fresh Root allocation of the existing signed HTTPS/OIDC,
// app_runtime/PG and installed-Chrome lane is mandatory before executing this file.
// Controlled originals use the internal retention owner, never a demo HTTP writer.
test.beforeAll(async()=>{app=await startManualProspectApp('773');});
test.afterAll(async()=>app?.stop());
const panel=(page:Page)=>page.getByRole('region',{name:'Retained public conversations',exact:true});
async function capture(expiresAt:string|null=null){
 const f=app.fixture,runtime=await f.database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 const input=publicThreadFixture(await databaseNow(ctx),undefined,expiresAt);
 const result=await withTransaction(runtime,()=>retainSocialPublicThread(ctx,input,{authority:async()=>true,publicationNow:now=>now}));if(!result.ok)throw Error(result.reason);return input;
}
async function login(page:Page){
 await routeManualProvider(page,app);await page.goto(app.origin);await expect(page.getByLabel('Workspace ID',{exact:true})).toBeVisible();await expect(page.getByText('Checking browser session…',{exact:true})).toHaveCount(0);
 await page.getByLabel('Workspace ID',{exact:true}).fill(app.fixture.alpha.workspaceId);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
 await page.getByRole('navigation',{name:'Workspace sections',exact:true}).getByRole('button',{name:'Social',exact:true}).click();await page.getByRole('button',{name:'Conversations',exact:true}).click();
}
test('signed web list/open reads actual retained owner originals without acquisition or public effects, and navigation drops projections',async({researchPage:page},testInfo)=>{
 const input=await capture(),tables=['social_accounts','social_posts','social_deliveries','social_draft_requests','provider_reservations','outbound_messages','jobs'];
 const counts=async()=>Promise.all(tables.map(async table=>(await app.fixture.db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']));const before=await counts();
 const routes:string[]=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(['/browser/api/social/threads/list','/browser/api/social/threads/read'].includes(path)){expect(request.method()).toBe('POST');routes.push(path);expect(request.postData()).not.toContain(input.snapshot.messages[0]!.text);}});
 await login(page);await panel(page).getByRole('button',{name:'Read retained public threads',exact:true}).click();await expect(panel(page).getByRole('button',{name:`Open snapshot ${input.threadId}`,exact:true})).toBeEnabled();
 await expect(panel(page)).not.toContainText(input.snapshot.messages[0]!.text);await panel(page).getByRole('button',{name:`Open snapshot ${input.threadId}`,exact:true}).click();
 await expect(panel(page)).toContainText(input.snapshot.messages[0]!.text);await expect(panel(page)).toContainText('Author unknown');await expect(panel(page)).toContainText('Text coverage truncated');
 await expect(panel(page)).toContainText(input.snapshot.url);expect(routes).toEqual(['/browser/api/social/threads/list','/browser/api/social/threads/read']);
 const readiness=page.getByRole('region',{name:'Publishing readiness',exact:true});
 await readiness.getByRole('button',{name:'Read publishing readiness',exact:true}).click();
 await expect(readiness).toContainText('Publishing remains unavailable.');await expect(readiness).toContainText('No saved accounts are available in this read.');expect(await counts()).toEqual(before);
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:testInfo.outputPath('public-thread-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:testInfo.outputPath('public-thread-mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});
 expect((await browserRequest(page,'/social/threads/capture',{body:input})).status).toBe(404);
 expect((await browserRequest(page,'/social/threads/read',{body:{threadId:input.threadId,expectedRevision:1},csrf:'forged'})).status).toBe(403);
 await page.getByRole('button',{name:'Posts',exact:true}).click();await expect(panel(page)).toHaveCount(0);await page.getByRole('button',{name:'Conversations',exact:true}).click();await expect(panel(page)).not.toContainText(input.snapshot.messages[0]!.text);
 expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(input.snapshot.messages[0]!.text);
 expect(await counts()).toEqual(before);expect(app.runtimeRequests()).toBeGreaterThan(0);expect(app.fixture.google.jwksFetches()).toBeGreaterThan(0);
});
test('exact source removal is physically terminal and a later signed list/open never revives the original',async({researchPage:page})=>{
 const input=await capture();await login(page);await panel(page).getByRole('button',{name:'Read retained public threads',exact:true}).click();await panel(page).getByRole('button',{name:`Open snapshot ${input.threadId}`,exact:true}).click();await expect(panel(page)).toContainText(input.snapshot.messages[0]!.text);
 const ctx=repositoryContext(workspaceScope(app.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),app.fixture.db);
 await withTransaction(app.fixture.db,()=>eraseSocialPublicThreadByIdentity(ctx,{ownerUserId:app.fixture.alpha.admin.userId,url:input.snapshot.url}));
 await panel(page).getByRole('button',{name:'Read retained public threads',exact:true}).click();await expect(panel(page)).not.toContainText(input.snapshot.messages[0]!.text);await expect(panel(page).getByRole('button',{name:`Open snapshot ${input.threadId}`,exact:true})).toHaveCount(0);
 expect((await app.fixture.db.query('SELECT revision,source_url,payload,payload_sha256,coverage,message_count FROM social_public_threads WHERE id=$1',[input.threadId])).rows[0]).toEqual({revision:2,source_url:null,payload:null,payload_sha256:null,coverage:null,message_count:null});
 const answer=await browserRequest(page,'/social/threads/read',{body:{threadId:input.threadId,expectedRevision:1}});expect(answer.status).toBe(200);expect(JSON.stringify(answer.body)).not.toContain(input.snapshot.messages[0]!.text);
});
test('known source expiry clears mounted original prose without a fetch or replay',async({researchPage:page})=>{
 const input=await capture(new Date(Date.now()+30000).toISOString());await page.clock.install();await login(page);
 await panel(page).getByRole('button',{name:'Read retained public threads',exact:true}).click();await panel(page).getByRole('button',{name:`Open snapshot ${input.threadId}`,exact:true}).click();await expect(panel(page)).toContainText(input.snapshot.messages[0]!.text);
 let reads=0;page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/browser/api/social/threads/'))reads++;});
 await page.clock.fastForward(31000);await expect(panel(page)).not.toContainText(input.snapshot.messages[0]!.text);await expect(page.getByRole('article',{name:'Opened public thread'})).toHaveCount(0);expect(reads).toBe(0);
});
