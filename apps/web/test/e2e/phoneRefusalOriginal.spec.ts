import assert from 'node:assert/strict';
import {expect,test as base} from 'playwright/test';
import {PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH,prospectPhoneDiscoveryViewSchema,prospectPhoneRefusalOriginalSchema} from '@fss/contracts';
import {browserRequest} from '../support/browser.ts';
import {assertGlassNoExternalActions,assertGlassStorage,containGlass,signInGlass} from '../support/glassWorkspaceApp.ts';
import {launchGlassContext} from '../support/glassWorkspaceBrowser.ts';
import {openPhoneDiscoveryCandidate,phoneDiscoveryPaths,withdrawPhoneDiscoverySource} from '../support/phoneDiscoveryApp.ts';
import {refusalOriginalText,startPhoneRefusalOriginalApp} from '../support/phoneRefusalOriginalApp.ts';

// Authored acceptance only. Fresh Root allocation is required, never inferred
// from typecheck, imports, an old fixture grant or a historical successful run.
const test=base.extend({context:async({browserName},use)=>{
 expect(owned).toBeDefined();expect(browserName).toBe('chromium');const browser=await launchGlassContext();try{await use(browser.context);}finally{await browser.stop();}
}});
let owned:Awaited<ReturnType<typeof startPhoneRefusalOriginalApp>>|undefined;
const app=()=>{assert(owned,'Selected-original runtime not allocated');return owned.app;};
test.use({ignoreHTTPSErrors:true,screenshot:'off',trace:'off',video:'off'});
test.describe.configure({timeout:180000});
test.beforeAll(async()=>{owned=await startPhoneRefusalOriginalApp();});
test.afterAll(async()=>{if(!owned)return;try{await assertGlassNoExternalActions(app());}finally{await owned.stop();owned=undefined;}});
test('signed registered API and Calling explicitly read one whole original, erase on reread/source loss, and create no jobs',async({context,page})=>{
 assert(owned);await containGlass(context,app());await signInGlass(page,app());
 const before=(await app().fixture.db.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows;
 const counts={capture:0,original:0};page.on('request',request=>{const path=new URL(request.url()).pathname;if(path===`/browser/api${phoneDiscoveryPaths.request}`)counts.capture++;if(path===`/browser/api${PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH}`)counts.original++;});
 const initial=await browserRequest(page,phoneDiscoveryPaths.read,{body:owned.candidate});expect(initial.status).toBe(200);
 const view=prospectPhoneDiscoveryViewSchema.parse(initial.body);expect(JSON.stringify(view)).not.toContain(refusalOriginalText);expect(view.phoneEvidence.state).toBe('conflicting');
 await openPhoneDiscoveryCandidate(page,owned.candidate.candidateId);
 const region=page.getByRole('region',{name:'Business phone discovery',exact:true});await region.getByRole('button',{name:'Read phone result',exact:true}).click();
 const result=region.getByLabel('Current phone discovery result',{exact:true});await result.getByText('Phone-specific sources and coverage',{exact:true}).click();
 expect(counts).toEqual({capture:0,original:0});
 const response=page.waitForResponse(value=>new URL(value.url()).pathname===`/browser/api${PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH}`);
 await result.getByRole('button',{name:'Read this retained refusal original',exact:true}).click();
 const raw=await response;expect(raw.status()).toBe(200);const original=prospectPhoneRefusalOriginalSchema.parse(await raw.json());
 expect(original).toMatchObject({candidateId:owned.candidate.candidateId,candidateRevision:1,text:refusalOriginalText,purpose:'manual_refusal_review',channelAuthority:'not_granted',location:{runId:owned.runId,observationId:owned.observationId,blockId:'selected-whole',labelStart:3,labelEnd:8}});
 const selected=result.getByRole('region',{name:'Selected retained refusal original',exact:true});await expect(selected.locator('pre')).toHaveText(refusalOriginalText);await expect(selected.locator('script,a')).toHaveCount(0);await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
 await assertGlassStorage(page,[refusalOriginalText]);expect(counts).toEqual({capture:0,original:1});
 await region.getByRole('button',{name:'Read phone result',exact:true}).click();await expect(selected).toHaveCount(0);expect(counts.original).toBe(1);
 await result.getByText('Phone-specific sources and coverage',{exact:true}).click();
 await result.getByRole('button',{name:'Read this retained refusal original',exact:true}).click();await expect(selected.locator('pre')).toHaveText(refusalOriginalText);
 await withdrawPhoneDiscoverySource(app());
 const refusalResponse=page.waitForResponse(value=>new URL(value.url()).pathname===`/browser/api${PROSPECT_PHONE_REFUSAL_ORIGINAL_PATH}`);
 await result.getByRole('button',{name:'Read this retained refusal original',exact:true}).click();
 const refused=await refusalResponse;expect(refused.status()).toBe(409);expect(JSON.stringify(await refused.json())).not.toContain(refusalOriginalText);
 await expect(page.getByText(refusalOriginalText,{exact:true})).toHaveCount(0);
 expect(counts.capture).toBe(0);expect(counts.original).toBe(3);expect(app().calls()).toBe(0);expect((await app().fixture.db.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows).toEqual(before);await assertGlassStorage(page,[refusalOriginalText]);
});
