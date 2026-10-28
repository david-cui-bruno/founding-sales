import {test as base,expect} from 'playwright/test';
import {dialCheckResponseSchema} from '@fss/contracts';
import {startCallingExecutionApp,seedCallingExecution,installCallingFake,type CallingExecutionApp} from '../support/callingExecutionApp.ts';
import {launchGlassContext} from '../support/glassWorkspaceBrowser.ts';
import {signInGlass,navigateGlass} from '../support/glassWorkspaceApp.ts';
import {containSyntheticBrowser} from '../support/syntheticBrowserApp.ts';

const test=base.extend({context:async({browserName},use)=>{
 expect(browserName).toBe('chromium');const owned=await launchGlassContext();
 try{await use(owned.context);}finally{await owned.stop();}
}});
test.use({screenshot:'off',trace:'off',video:'off'});
test.describe.configure({timeout:120000});
let owned:CallingExecutionApp,seed:Awaited<ReturnType<typeof seedCallingExecution>>;
test.beforeAll(async()=>{
 owned=await startCallingExecutionApp();
 try{
  seed=await seedCallingExecution(owned);
  await owned.app.fixture.db.query("UPDATE workspace_settings SET value='{\"provider\":\"tel\"}'::jsonb WHERE workspace_id=$1 AND setting_key='calling_provider'",[owned.app.fixture.alpha.workspaceId]);
 }catch(error){await owned.stop();throw error;}
});
test.afterAll(async()=>{if(owned)await owned.stop();});

test('signed read-only readiness exposes provider OFF before microphone setup at desktop and narrow widths',async({context,page})=>{
 await containSyntheticBrowser(context,owned.app);await installCallingFake(context,owned);
 const effects:string[]=[];
 page.on('request',request=>{if(/\/calls\/(?:access-token|session)$|\/calling\/wrap$/u.test(new URL(request.url()).pathname))effects.push(request.url());});
 await signInGlass(page,owned.app);await navigateGlass(page,'Calling');
 await page.getByRole('button',{name:'Prepared queue',exact:true}).click();
 await page.locator('.calling-queue li button').filter({hasText:seed.name}).click();
 await expect(page.getByRole('combobox',{name:'Browser calling identity'})).toHaveValue(seed.identityId);
 await page.getByRole('combobox',{name:'Browser call route'}).selectOption({index:1});
 const region=page.getByRole('region',{name:'Call readiness'}),button=region.getByRole('button',{name:'Check call readiness',exact:true});
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/browser/api/dial/check');
 await button.click();const read=await response;expect(read.status()).toBe(200);
 const answer=dialCheckResponseSchema.parse(await read.json());expect(answer.advice.firmId).toBe(seed.preparedFirmId);expect(answer.advice.telUri).toBeNull();
 await expect(region).toContainText('Browser calling is off.');await expect(region).toContainText('Your selected calling identity is currently available.');await expect(region).toContainText('National DNC: checked clear');
 const directory=process.env['FSS_GLASS_PRIVATE_ARTIFACTS']!;
 for(const [name,width,height] of [['desktop',1440,1000],['narrow',390,844]] as const){
  await page.setViewportSize({width,height});await region.scrollIntoViewIfNeeded();
  await expect(button).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await region.screenshot({path:`${directory}/readiness-${name}.png`});
 }
 expect(await page.evaluate(()=>window.__callingFake.microphones)).toBe(0);
 expect(await page.evaluate(()=>window.__callingFake.constructed)).toBe(0);
 expect(owned.counters.tokens).toBe(0);expect(owned.counters.connects).toBe(0);expect(owned.counters.providerNetwork).toBe(0);expect(owned.counters.externalNode).toBe(0);expect(owned.counters.externalBrowser).toBe(0);expect(effects).toEqual([]);
 for(const table of ['call_sessions','calling_follow_up_drafts','provider_reservations','outbound_messages','human_reply_send_intents','social_deliveries'])expect((await owned.app.fixture.db.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
 console.log('CALLING_READINESS_ACCEPTED',JSON.stringify({firmId:seed.preparedFirmId,provider:'off',microphones:0,tokens:0,sessions:0,providerNetwork:0,widths:[1440,390]}));
});

test('remote version drift clears readiness even when the route ID and number stay unchanged',async({context,page})=>{
 await containSyntheticBrowser(context,owned.app);await installCallingFake(context,owned);
 await signInGlass(page,owned.app);await navigateGlass(page,'Calling');
 await page.getByRole('button',{name:'Prepared queue',exact:true}).click();
 await page.locator('.calling-queue li button').filter({hasText:seed.name}).click();
 await expect(page.getByRole('combobox',{name:'Browser calling identity'})).toHaveValue(seed.identityId);
 await page.getByRole('combobox',{name:'Browser call route'}).selectOption({index:1});
 const region=page.getByRole('region',{name:'Call readiness'});
 await page.route('**/browser/api/dial/check',async route=>{
  const result=await route.fetch();expect(result.status()).toBe(200);
  await owned.app.fixture.db.query('UPDATE phone_routes SET version=version+1 WHERE firm_id=$1',[seed.preparedFirmId]);
  await route.fulfill({response:result});
 });
 await region.getByRole('button',{name:'Check call readiness',exact:true}).click();
 await expect(region).toContainText('Calling checks unavailable or the recorded route changed.');
 await expect(region).not.toContainText('Policy snapshot:');
 expect(await page.evaluate(()=>window.__callingFake.microphones)).toBe(0);expect(owned.counters.tokens).toBe(0);
 console.log('CALLING_READINESS_REMOTE_VERSION_DRIFT_REFUSED');
});

test('Firm merge during an actual registry wait erases private advice before returning it',async({context,page})=>{
 const f=owned.app.fixture;
 owned.app.chooseIdentity(f.alpha.admin);
 await containSyntheticBrowser(context,owned.app);await installCallingFake(context,owned);
 await signInGlass(page,owned.app);await navigateGlass(page,'Calling');
 await page.getByRole('button',{name:'Prepared queue',exact:true}).click();
 await page.locator('.calling-queue li button').filter({hasText:seed.name}).click();
 await expect(page.getByRole('combobox',{name:'Browser calling identity'})).toHaveValue(seed.identityId);
 await page.getByRole('combobox',{name:'Browser call route'}).selectOption({index:1});
 const observer=await f.database.appRuntimeSession();
 const blocker=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
 await f.db.query('BEGIN');
 try{
  await f.db.query('SELECT id FROM national_registry_snapshots WHERE workspace_id=$1 FOR UPDATE',[f.alpha.workspaceId]);
  let server:unknown=null;
  // Inspect the real gateway response before browser invalidation can abort body consumption.
  await page.route('**/browser/api/dial/check',async route=>{const answer=await route.fetch();server={status:answer.status(),body:await answer.json()};await route.fulfill({response:answer});});
  await page.getByRole('button',{name:'Check call readiness',exact:true}).click();
  await expect.poll(async()=> {await f.db.query('SELECT pg_stat_clear_snapshot()');return (await f.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM national_registry_snapshots%' AND $1=ANY(pg_blocking_pids(pid))`,[blocker])).rowCount;},{timeout:10000}).toBe(1);
  await observer.query("UPDATE firms SET status='merged',merged_into_firm_id=$2 WHERE id=$1",[seed.preparedFirmId,owned.app.firmId]);
  await f.db.query('COMMIT');
  await expect.poll(()=>server).toEqual({status:401,body:{error:'browser_request_refused'}});
  await expect(page.getByRole('region',{name:'Call readiness'})).toHaveCount(0);
 }finally{await f.db.query('ROLLBACK');owned.app.chooseIdentity(f.alpha.admin);}
 expect(await page.evaluate(()=>window.__callingFake.microphones)).toBe(0);expect(await page.evaluate(()=>window.__callingFake.constructed)).toBe(0);
 expect(owned.counters.tokens).toBe(0);expect(owned.counters.connects).toBe(0);expect(owned.counters.providerNetwork).toBe(0);expect(owned.counters.externalNode).toBe(0);expect(owned.counters.externalBrowser).toBe(0);
 for(const table of ['call_sessions','calling_follow_up_drafts','provider_reservations','outbound_messages','human_reply_send_intents','social_deliveries'])expect((await f.db.query(`SELECT 1 FROM ${table}`)).rowCount).toBe(0);
 console.log('CALLING_READINESS_ACTUAL_WAIT_MERGE_REFUSED',JSON.stringify({requestRole:'app_runtime',microphones:0,tokens:0,sessions:0,effects:0}));
});
