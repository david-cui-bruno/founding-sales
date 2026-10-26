import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {expect,test as base} from 'playwright/test';
import {manualProspectListSchema,prospectPhoneDiscoveryViewSchema} from '@fss/contracts';
import {browserRequest} from '../support/browser.ts';
import {assertGlassNoExternalActions,containGlass,signInGlass} from '../support/glassWorkspaceApp.ts';
import {launchGlassContext} from '../support/glassWorkspaceBrowser.ts';
import {openPhoneDiscoveryCandidate,phoneDiscoveryCase,phoneDiscoveryPaths,requirePhoneDiscoveryRuntimeGrant,seedPhoneDiscoveryCandidate,startPhoneDiscoveryApp,withdrawPhoneDiscoverySource} from '../support/phoneDiscoveryApp.ts';

// One controlled local case passed October26 at6cd768275, then all resources
// were released. Fresh Root allocation is mandatory for any future run. Only
// crafted retained originals are seeded, no request, job dispatch or provider.
const test=base.extend({context:async({browserName},use)=>{
 expect(owned).toBeDefined();expect(browserName).toBe('chromium');
 const browser=await launchGlassContext();try{await use(browser.context);}finally{await browser.stop();}
}});
let owned:Awaited<ReturnType<typeof startPhoneDiscoveryApp>>|undefined;
let candidate:Awaited<ReturnType<typeof seedPhoneDiscoveryCandidate>>;
let runId:string,retrievedAt:string;
const text='🏡 Phone: unavailable',blocks=[{id:'refusal-label',text}];
const app=()=>{assert(owned,'Fresh Root-owned phone refusal runtime required');return owned.app;};
test.use({ignoreHTTPSErrors:true,screenshot:'off',trace:'off',video:'off'});
test.describe.configure({timeout:180000});
test.beforeAll(async()=>{
 assert.equal(process.env['FSS_PHONE_REFUSAL_READ_RUNTIME_GRANT'],'retained-only','Fresh Root read-fixture grant required');
 requirePhoneDiscoveryRuntimeGrant();owned=await startPhoneDiscoveryApp();candidate=await seedPhoneDiscoveryCandidate(app());
 runId=randomUUID();
 const db=app().fixture.db,w=app().fixture.alpha.workspaceId,user=app().fixture.alpha.admin.userId;
 const requested=(await db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
 const context={website:phoneDiscoveryCase.website,sourceUrls:[phoneDiscoveryCase.sourceUrl],observations:[]};
 await db.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,requested_at,deadline_at,expires_at,content)
  VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1','pending',$5,$5::timestamptz+interval '30 minutes',$5::timestamptz+interval '1 hour',$6::jsonb)`,[w,runId,candidate.candidateId,user,requested,JSON.stringify(context)]);
 await db.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[w,runId]);
 retrievedAt=(await db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
 const observation={id:randomUUID(),url:phoneDiscoveryCase.phoneUrl,contentHash:createHash('sha256').update(text).digest('hex'),relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 await db.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$3::jsonb WHERE workspace_id=$1 AND id=$2",[w,runId,JSON.stringify({...context,observations:[observation]})]);
});
test.afterAll(async()=>{if(!owned)return;try{await assertGlassNoExternalActions(app());}finally{await owned.stop();owned=undefined;}});
test('registered read/list and mounted refusal use retained originals without acquisition or a synthetic endpoint',async({context,page})=>{
 await containGlass(context,app());await signInGlass(page,app());
 const baseline=(await app().fixture.db.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows;
 let requests=0;page.on('request',request=>{if(new URL(request.url()).pathname===`/browser/api${phoneDiscoveryPaths.request}`)requests++;});
 const read=async()=>{
  const response=await browserRequest(page,phoneDiscoveryPaths.read,{body:candidate});expect(response.status).toBe(200);
  return prospectPhoneDiscoveryViewSchema.nullable().parse(response.body);
 };
 const first=await read();expect(first).toMatchObject({runId,state:'complete',phoneEvidence:{state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{truncated:false,entries:[{reason:'unattached_label_content',label:'Phone',labelStart:3,labelEnd:8,url:phoneDiscoveryCase.phoneUrl,retrievedAt}]}}});
 const list=await browserRequest(page,'/sourcing/candidates/prospects/list',{body:{state:'all',offset:0}});expect(list.status).toBe(200);
 expect(manualProspectListSchema.parse(list.body).prospects.find(row=>row.candidateId===candidate.candidateId)).toMatchObject({observedPhone:null,phoneEvidence:first?.phoneEvidence,contactAuthority:'not_granted'});
 await openPhoneDiscoveryCandidate(page,candidate.candidateId);
 const region=page.getByRole('region',{name:'Business phone discovery',exact:true});await region.getByRole('button',{name:'Read phone result',exact:true}).click();
 const result=region.getByLabel('Current phone discovery result',{exact:true});await result.getByText('Phone-specific sources and coverage',{exact:true}).click();
 await expect(result).toContainText('Unattached label content');await expect(result).toContainText('explanation, not evidence of competing numbers');await expect(result).toContainText('Label Phone · UTF-16 [3, 8)');await expect(result).toContainText(retrievedAt);
 await expect(result.locator('a')).toHaveCount(0);await expect(result.locator('button')).toHaveCount(0);await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
 await page.reload();expect(await read()).toEqual(first);
 await withdrawPhoneDiscoverySource(app());const lost=await read();expect(lost===null||lost.state==='unavailable').toBe(true);expect(JSON.stringify(lost)).not.toContain('unattached_label_content');
 expect(requests).toBe(0);expect(app().calls()).toBe(0);expect((await app().fixture.db.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows).toEqual(baseline);
});
