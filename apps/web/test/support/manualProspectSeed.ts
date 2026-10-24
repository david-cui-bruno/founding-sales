import assert from 'node:assert/strict';
import type {Page} from 'playwright/test';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {saveDiscoveryCandidate} from '@fss/domain/sourcing/discoveryIntake.ts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from '../../../../packages/domain/test/sourcing/support/manualProspectFixture.ts';
import type {ManualProspectApp} from './manualProspectApp.ts';
export async function seedManualProspects(app:ManualProspectApp){
 const f=app.fixture,runtime=await f.database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),runtime);
 const ids:string[]=[];
 for(let i=0;i<51;i++){const input=manualDiscoveryFixture(`browser-${i}`);const result=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx,input));assert(result.ok);ids.push(result.value.id);}
 for(const key of ['dup-a','dup-b']){const input=manualDiscoveryFixture(key);input.row.firmName='Possible duplicate observation';input.row.website='https://duplicate.example.test/';const result=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx,input));assert(result.ok);ids.push(result.value.id);}
 const input=manualDiscoveryFixture('hostile');input.row.firmName='<img src=x onerror=alert(1)> Unverified raw';input.row.website='javascript:alert(1)';const raw=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx,input));assert(raw.ok);ids.push(raw.value.id);
 const ordinary=await withTransaction(runtime,()=>saveCandidate(ctx,manualOrdinaryFixture(764)));assert(ordinary.ok);ids.push(ordinary.value.id);
 const betaCtx=repositoryContext(workspaceScope(f.beta.workspaceId,{kind:'user',userId:f.beta.admin.userId,role:'admin'}),runtime),beta=await withTransaction(runtime,()=>saveDiscoveryCandidate(betaCtx,manualDiscoveryFixture('beta-only')));assert(beta.ok);
 return {ids,rawId:raw.value.id,ordinaryId:ordinary.value.id,betaId:beta.value.id};
}
export async function manualProductSnapshot(app:ManualProspectApp){
 const value:Record<string,unknown[]>={};
 for(const table of ['sourcing_candidates','sourcing_candidate_discovery_origins','sourcing_qualification_runs','jobs','provider_reservations','firms','contacts','phone_routes','email_addresses','sequence_enrollments','outbound_messages','sourcing_admissions','suppression_events'])value[table]=(await app.fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return value;
}
export async function routeManualProvider(page:Page,app:ManualProspectApp){
 await page.context().route('**/*',async route=>{
  const url=new URL(route.request().url());if(url.origin!==app.origin)return route.abort('blockedbyclient');
  if(url.pathname!=='/browser/sign-in')return route.continue();const response=await route.fetch(),body=await response.json() as {authorizationUrl?:string};
  if(response.status()!==200||!body.authorizationUrl)return route.fulfill({response});const auth=new URL(body.authorizationUrl);assert.equal(auth.origin,app.fixture.google.issuer);
  return route.fulfill({response,json:{authorizationUrl:`${app.origin}/__local/provider?${auth.searchParams}`}});
 });
}
export async function loginManual(page:Page,app:ManualProspectApp,who:'alpha'|'beta'|'sales'='alpha'){
 const workspace=who==='beta'?app.fixture.beta:app.fixture.alpha;app.chooseIdentity(who==='sales'?workspace.salesperson:workspace.admin);await page.goto(app.origin);await page.getByLabel('Workspace ID',{exact:true}).fill(workspace.workspaceId);await page.getByRole('button',{name:'Sign in',exact:true}).click();
}
