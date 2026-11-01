import {afterAll,beforeAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {runDiscovery} from '../../sourcing/discovery.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification,QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
import {LEGACY_QUALIFICATION_PRODUCER} from '../../sourcing/preparedIdentity.ts';
import {VERIFIED_FIRM_POLICY_VERSION} from '../../sourcing/verifiedFirmPolicy.ts';
import {DEFAULT_RESEARCH_SETTINGS} from '../../research/settings.ts';
import type {DiscoveryHit} from '../../sourcing/discoveryProvider.ts';
import type {PageFetchProvider} from '../../research/providers.ts';
import {htmlPageFetch} from './support/discoveryPageFetch.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';

let db:TestDatabase;let workspaceId:string;let adminId:string;
beforeAll(async()=>{
 db=await createTestDatabase();const seeded=await seedTwoWorkspaces(db.session);workspaceId=seeded.alpha.workspaceId;adminId=seeded.alpha.admin.userId;
 await db.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');
 await db.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,enabled) VALUES($1,true)',[workspaceId]);
});
afterAll(async()=>{await db.drop();});
const ctx=(component:'worker'|'scheduler'='worker')=>repositoryContext(workspaceScope(workspaceId,{kind:'system',component}),db.session);
/** One fresh daily search; earlier attempts move to earlier days so the one slot is free. */
async function search(hits:readonly DiscoveryHit[],pageFetch:PageFetchProvider){
 await db.session.query('UPDATE sourcing_discovery_attempts SET day=day-1');
 await db.session.query('UPDATE sourcing_search_account SET halted=false,daily_used=0,monthly_used=0');
 await db.session.query('UPDATE sourcing_discovery_settings SET next_run_at=now()');
 await runDiscovery(ctx(),{providerKey:'tavily_basic',discover:async()=>({ok:true,credits:1,requestId:'company-intake',hits})},pageFetch);
 return (await db.session.query<{id:string}>('SELECT id FROM sourcing_discovery_attempts ORDER BY created_at DESC LIMIT 1')).rows[0]!.id;
}
const websites=async(prefix:string)=>(await db.session.query<{website:string}>("SELECT payload->>'website' AS website FROM sourcing_candidates WHERE workspace_id=$1 AND payload->>'website' LIKE $2 ORDER BY 1",[workspaceId,`%${prefix}%`])).rows.map(r=>r.website);
const expansions=async(attempt:string)=>(await db.session.query<{detail:unknown}>("SELECT detail FROM audit_events WHERE action='sourcing.discovery_list_expanded' AND subject_id::text=$1 ORDER BY detail->>'listUrl'",[attempt])).rows.map(r=>r.detail);
const hitLinks=async(attempt:string)=>Object.fromEntries((await db.session.query<{source_url:string;candidate_id:string|null}>('SELECT source_url,candidate_id FROM sourcing_discovery_hits WHERE attempt_id=$1',[attempt])).rows.map(r=>[r.source_url,r.candidate_id!==null]));
const link=(host:string,text:string)=>`<a href="https://${host}/">${text}</a>`;

it('creates direct company hits and a listicle\'s listed company hosts, never the list page or noise',async()=>{
 const list='https://blog.mix.example.test/top-10-dallas';
 const pageFetch=htmlPageFetch({[list]:`<p>Our picks</p>${link('listed-one.mix.example.test','Listed One Property Management')}<a href="https://blog.mix.example.test/about">About</a>${link('www.yelp.com','Yelp')}<a href="https://listed-two.mix.example.test/home#team"><img alt=""></a>`});
 const attempt=await search([
  {url:'https://alpha.mix.example.test/',title:'Alpha PM | Dallas',snippet:'Alpha manages rentals'},
  {url:list,title:'Top 10 Property Management Companies in Dallas',snippet:'Ranked list'},
  {url:'https://en.wikipedia.org/wiki/Property_management',title:'Property management - Wikipedia',snippet:'Encyclopedia'},
  {url:'https://beta.mix.example.test/',title:'Beta Realty',snippet:'Beta leasing'},
 ],pageFetch);
 expect(pageFetch.requests).toHaveLength(1);
 expect(pageFetch.requests[0]).toMatchObject({urls:[list],firmWebsite:list,links:[list],maxPagesPerFirm:1,maxBytes:DEFAULT_RESEARCH_SETTINGS.maxPageBytes});
 expect(await pageFetch.requests[0]!.shouldContinue!()).toBe(true);
 expect(await websites('mix.example.test')).toEqual(['https://alpha.mix.example.test/','https://beta.mix.example.test/','https://listed-one.mix.example.test/','https://listed-two.mix.example.test/home']);
 const lead=(await db.session.query<{status:string;payload:Record<string,unknown>}>("SELECT status,payload FROM sourcing_candidates WHERE payload->>'website'='https://listed-one.mix.example.test/'")).rows[0]!;
 expect(lead.status).toBe('needs_review');
 expect(lead.payload).toMatchObject({firmName:'Listed One Property Management',website:'https://listed-one.mix.example.test/',sourceUrl:'https://listed-one.mix.example.test/',signal:'fit_only',evidence:`Listed on ${list}: Listed One Property Management`,preparedBy:'Tavily Basic search · not verified',discoveryQuery:expect.any(String)});
 expect(lead.payload).not.toHaveProperty('discoveryKnownDomain');
 expect((await db.session.query("SELECT payload->>'firmName' AS name FROM sourcing_candidates WHERE payload->>'website'='https://listed-two.mix.example.test/home'")).rows).toEqual([{name:'listed-two.mix.example.test'}]);
 // Raw retention keeps every hit; only direct company hits link to a candidate.
 expect(await hitLinks(attempt)).toEqual({'https://alpha.mix.example.test/':true,[list]:false,'https://en.wikipedia.org/wiki/Property_management':false,'https://beta.mix.example.test/':true});
 expect(await expansions(attempt)).toEqual([{listUrl:list,leads:2,created:2}]);
 expect((await db.session.query('SELECT id FROM firms')).rows).toHaveLength(0);
});

it('skips hosts already held by a candidate or Firm and repeated hosts within one search',async()=>{
 const saved=await withTransaction(db.session,()=>saveCandidate(ctx(),{firmName:'Known Candidate',website:'https://www.known-candidate.dup.example.test/about',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Manual',sourceUrl:'https://www.known-candidate.dup.example.test/about',observedOn:'2026-10-01',preparedBy:'Manual'}));
 if(!saved.ok)throw new Error(saved.reason);
 await db.session.query("INSERT INTO firms(workspace_id,name,website) VALUES($1,'Known Firm','https://WWW.known-firm.dup.example.test/contact')",[workspaceId]);
 const list='https://www.expertise.com/tx/dallas/property-management';
 const pageFetch=htmlPageFetch({[list]:link('known-firm.dup.example.test','Known Firm PM')+link('repeat.dup.example.test','Repeat PM')+link('known-candidate.dup.example.test','Known Candidate PM')});
 const attempt=await search([
  {url:'https://known-candidate.dup.example.test/',title:'Known Candidate',snippet:'Same host, different page'},
  {url:list,title:'Best Property Managers',snippet:'Directory'},
  {url:'https://www.repeat.dup.example.test/b',title:'Repeat PM',snippet:'Second sighting'},
  {url:'https://fresh.dup.example.test/',title:'Fresh PM',snippet:'New'},
  {url:'https://fresh.dup.example.test/contact',title:'Fresh PM contact',snippet:'Same search, same host'},
 ],pageFetch);
 expect(await websites('dup.example.test')).toEqual(['https://fresh.dup.example.test/','https://repeat.dup.example.test/','https://www.known-candidate.dup.example.test/about']);
 expect(await expansions(attempt)).toEqual([{listUrl:list,leads:3,created:1}]);
 expect(await hitLinks(attempt)).toMatchObject({'https://known-candidate.dup.example.test/':false,'https://www.repeat.dup.example.test/b':false,'https://fresh.dup.example.test/':true,'https://fresh.dup.example.test/contact':false});
});

it('keeps five new candidates per search across direct hits and list leads, in search-rank order, expanding at most three lists',async()=>{
 const lists=Array.from({length:4},(_,i)=>`https://lists.cap.example.test/top-${i}`);
 const pageFetch=htmlPageFetch({
  [lists[0]!]:['l1','l2','l3'].map(h=>link(`${h}.cap.example.test`,`${h} PM`)).join(''),
  [lists[1]!]:link('l4.cap.example.test','l4 PM')+link('l5.cap.example.test','l5 PM'),
  [lists[2]!]:link('l6.cap.example.test','l6 PM'),
  [lists[3]!]:link('l7.cap.example.test','l7 PM'),
 });
 const attempt=await search([
  {url:'https://first.cap.example.test/',title:'First PM',snippet:''},
  ...lists.map((url,i)=>({url,title:`Top ${i+5} Property Management Companies`,snippet:''})),
  {url:'https://last.cap.example.test/',title:'Last PM',snippet:''},
 ],pageFetch);
 expect(pageFetch.requests.map(r=>r.urls[0])).toEqual(lists.slice(0,3));
 expect(await websites('cap.example.test')).toEqual(['https://first.cap.example.test/','https://l1.cap.example.test/','https://l2.cap.example.test/','https://l3.cap.example.test/','https://l4.cap.example.test/']);
 expect(await expansions(attempt)).toEqual([{listUrl:lists[0],leads:3,created:3},{listUrl:lists[1],leads:2,created:1},{listUrl:lists[2],leads:1,created:0}]);
 expect(await hitLinks(attempt)).toMatchObject({'https://first.cap.example.test/':true,'https://last.cap.example.test/':false});
});

it('creates nothing from a refused, failed or throwing list fetch and still completes the search',async()=>{
 const lists=['https://refused.fail.example.test/top-10','https://broken.fail.example.test/top-10','https://empty.fail.example.test/top-10'];
 let calls=0;
 const pageFetch:PageFetchProvider={providerKey:'fixture',fetchPages:async()=>{
  calls++;
  if(calls===1)return {ok:false,failureCode:'robots_refused',costCents:0};
  if(calls===2)throw new Error('socket closed');
  return {ok:true,costCents:0,value:{pages:[],skipped:{paused:1}}};
 }};
 const attempt=await search(lists.map(url=>({url,title:'Top 10 Property Managers',snippet:''})),pageFetch);
 expect(calls).toBe(3);
 expect(await websites('fail.example.test')).toEqual([]);
 expect(await expansions(attempt)).toEqual([...lists].sort().map(listUrl=>({listUrl,leads:0,created:0})));
 expect((await db.session.query('SELECT state FROM sourcing_discovery_attempts WHERE id=$1',[attempt])).rows).toEqual([{state:'complete'}]);
 expect((await db.session.query('SELECT halted FROM sourcing_search_account')).rows).toEqual([{halted:false}]);
 expect((await db.session.query("SELECT id FROM provider_reservations")).rows).toEqual([]);
});

it('gives a list lead ordinary legacy-producer capture even under the strict attestation, never strict source authority',async()=>{
 await db.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,true,100) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,daily_firm_ceiling=100',[workspaceId]);
 await db.session.query('UPDATE sourcing_discovery_settings SET auto_admission_enabled=true,owner_user_id=$2,qualification_evaluation=$3::jsonb WHERE workspace_id=$1',[workspaceId,adminId,JSON.stringify({verifiedFirmPolicyVersion:VERIFIED_FIRM_POLICY_VERSION,promptVersion:QUALIFICATION_PROMPT_VERSION,policyVersion:QUALIFICATION_POLICY_VERSION,reportSha256:'a'.repeat(64),reviewedEligible:3,falseEligible:0})]);
 const list='https://blog.producer.example.test/best-10';
 await search([{url:list,title:'Best 10 Property Management Companies',snippet:''}],htmlPageFetch({[list]:link('lead.producer.example.test','Lead Property Management')}));
 const lead=(await db.session.query<{id:string;revision:number}>("SELECT id,revision FROM sourcing_candidates WHERE payload->>'website'='https://lead.producer.example.test/'")).rows[0]!;
 const queued=await withTransaction(db.session,()=>requestQualification(ctx('scheduler'),{candidateId:lead.id,expectedRevision:lead.revision},{enqueue:false}));
 expect(queued).toMatchObject({ok:true});
 expect((await db.session.query('SELECT producer_version FROM sourcing_qualification_runs WHERE candidate_id=$1',[lead.id])).rows).toEqual([{producer_version:LEGACY_QUALIFICATION_PRODUCER}]);
});

it('skips hosts held only by discovery-v1 rows, observations or origins without spending a creation slot',async()=>{
 const admin=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:adminId,role:'admin'}),db.session);
 const retained=(recordId:string,provider:'overture_places'|'first_party',sourceUrl:string,website:string|null)=>{
  const source={provider,recordId,release:'fixture-release',retrievedAt:null,sourceUrl};
  return withTransaction(db.session,()=>saveDiscoveryCandidate(admin,{row:{source,observations:[source],firmName:`Retained ${recordId}`,website,locality:null,region:'TX',sourceConfidence:0.7,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'observed_source',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[{"dataset":"synthetic","license":"CDLA-Permissive-2.0"}]'},licenses:['CDLA-Permissive-2.0'],notices:[{label:'Fixture notice',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]}));
 };
 // A bare row website, and a first-party origin source with no website at all.
 expect(await retained('v1-site','overture_places','https://places.example.test/v1-site','WWW.V1-Site.v1.example.test/about')).toMatchObject({ok:true});
 expect(await retained('v1-origin','first_party','https://v1-origin.v1.example.test/contact',null)).toMatchObject({ok:true});
 const list='https://blog.v1.example.test/top-10';
 const attempt=await search([
  {url:list,title:'Top 10 Property Management Companies',snippet:''},
  {url:'https://v1-site.v1.example.test/',title:'V1 Site PM',snippet:''},
  {url:'https://www.v1-origin.v1.example.test/home',title:'V1 Origin PM',snippet:''},
  ...Array.from({length:5},(_,i)=>({url:`https://f${i}.v1.example.test/`,title:`Fresh ${i} PM`,snippet:''})),
 ],htmlPageFetch({[list]:link('v1-site.v1.example.test','V1 Site PM')+link('v1-origin.v1.example.test','V1 Origin PM')}));
 expect(await websites('v1.example.test')).toEqual(Array.from({length:5},(_,i)=>`https://f${i}.v1.example.test/`));
 expect(await expansions(attempt)).toEqual([{listUrl:list,leads:2,created:0}]);
 expect(await hitLinks(attempt)).toMatchObject({'https://v1-site.v1.example.test/':false,'https://www.v1-origin.v1.example.test/home':false});
});
