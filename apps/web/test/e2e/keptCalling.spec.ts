import {test as base,expect} from 'playwright/test';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {requestProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import {startGlassWorkspace,containGlass,signInGlass,navigateGlass,assertGlassStorage,assertGlassNoExternalActions} from '../support/glassWorkspaceApp.ts';
import {launchGlassContext} from '../support/glassWorkspaceBrowser.ts';
import {seedPhoneDiscoveryCandidate,setPhoneDiscoveryResearch,drivePhoneDiscoveryJob,phoneDiscoveryCase} from '../support/phoneDiscoveryApp.ts';

const test=base.extend({context:async({browserName},use)=>{expect(browserName).toBe('chromium');const browser=await launchGlassContext();try{await use(browser.context);}finally{await browser.stop();}}});
test.use({screenshot:'off',trace:'off',video:'off'});test.describe.configure({timeout:120000});
let owned:Awaited<ReturnType<typeof startGlassWorkspace>>,candidate:Awaited<ReturnType<typeof seedPhoneDiscoveryCandidate>>;
test.beforeAll(async()=>{
 expect(process.env['FSS_KEPT_CALLING_BROWSER_GRANT']).toBe('818');owned=await startGlassWorkspace();
 try{
  const database=(await owned.app.fixture.db.query<{version:string;encoding:string;schema:number}>("SELECT current_setting('server_version_num') version,current_setting('server_encoding') encoding,(SELECT max(version) FROM schema_versions) schema")).rows[0]!;
  expect(database.version).toMatch(/^16/u);expect(database.encoding).toBe('UTF8');expect(database.schema).toBe(143);
  candidate=await seedPhoneDiscoveryCandidate(owned.app);await setPhoneDiscoveryResearch(owned.app,true);
  const runtime=await owned.app.fixture.database.appRuntimeSession(),admin=owned.app.fixture.alpha.admin;
  const ctx=repositoryContext(workspaceScope(owned.app.fixture.alpha.workspaceId,{kind:'user',userId:admin.userId,role:'admin'}),runtime);
  const requested=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx,candidate));if(!requested.ok)throw Error(requested.reason);
  await drivePhoneDiscoveryJob(owned.app,requested.value.runId);
 }catch(error){await owned.stop();throw error;}
});
test.afterAll(async()=>{if(owned)try{await assertGlassNoExternalActions(owned.app);}finally{await owned.stop();}});

// One818-only current product case. The source fixture is fictional and prepared
// before sign-in; no old phone acquisition or Calling workflow is replayed.
test('signed manual choice persists through current read, kept navigation and browser reload without calling effects',async({context,page})=>{
 await containGlass(context,owned.app);const effects:string[]=[];
 page.on('request',request=>{if(/\/calls\/(?:access-token|session)$|\/calling\/wrap$/u.test(new URL(request.url()).pathname))effects.push(request.url());});
 await signInGlass(page,owned.app);await navigateGlass(page,'Calling');
 await expect(page.getByRole('button',{name:'Kept prospects',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Retained list',exact:true}).click();await page.locator('.calling-queue li button').filter({hasText:phoneDiscoveryCase.name}).click();
 const brief=page.getByRole('region',{name:'Current calling brief'});
 await brief.getByText('Phone-specific sources and coverage',{exact:true}).first().click();
 const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/browser/api/sourcing/candidates/prospects/feedback');
 await brief.getByRole('button',{name:`Keep ${phoneDiscoveryCase.phone} in Calling`,exact:true}).click();
 const answer=await saved;expect(answer.status()).toBe(200);expect(await answer.json()).toMatchObject({status:'accepted',replayed:false,result:{candidateId:candidate.candidateId,state:'kept',phoneChoice:{runId:expect.any(String)}}});
 await expect(brief.getByLabel('Chosen manual number')).toContainText(phoneDiscoveryCase.phone);
 await page.getByRole('button',{name:'Next prospect →',exact:true}).click();
 await expect(page.locator('.calling-queue li button').filter({hasText:phoneDiscoveryCase.name})).toContainText(phoneDiscoveryCase.phone);
 await page.reload();await navigateGlass(page,'Calling');
 const kept=page.locator('.calling-queue li button').filter({hasText:phoneDiscoveryCase.name});await expect(kept).toContainText(phoneDiscoveryCase.phone);
 await kept.click();await expect(page.getByLabel('Chosen manual number')).toContainText(phoneDiscoveryCase.phone);
 await assertGlassStorage(page,[phoneDiscoveryCase.name,phoneDiscoveryCase.text,phoneDiscoveryCase.phone,phoneDiscoveryCase.website]);
 expect(effects).toEqual([]);for(const table of ['call_sessions','calling_follow_up_drafts','sourcing_manual_prospect_attempts'])expect((await owned.app.fixture.db.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
 console.log('KEPT_CALLING_818_ACCEPTED',JSON.stringify({candidateId:candidate.candidateId,savedAndReloaded:true,callEffects:0}));
});
