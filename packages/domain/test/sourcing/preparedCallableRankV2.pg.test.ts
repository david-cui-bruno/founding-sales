import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {refreshCallableRanks} from '../../sourcing/callableRanks.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';

// ADR0034: the rank worker reads CURRENT prepared-capture (v2) companies under its own custody, so a phone published only on a
// linked contact page ranks the company exactly as the admin list sees it.
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(worker=false)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),runtime);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
const html=(body:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
const ranks=async()=>(await runtime.query<{candidate_id:string;rank:number|null;company_host:string|null}>('SELECT candidate_id,rank,company_host FROM sourcing_callable_ranks ORDER BY candidate_id')).rows;
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await tx(async()=>{await lockDiscoveryReviewSources(ctx());await runtime.query('DELETE FROM sourcing_candidates');});await runtime.query('DELETE FROM research_settings');await runtime.query('DELETE FROM daily_counters');});
afterAll(async()=>db?.drop());

/** A landing page (the exact candidate source) that links to its own contact, about,
 * team and service pages, a second contact page and another company's site. */
async function capture(options:{maxPages?:number;source?:(site:string)=>string;extra?:(site:string)=>Record<string,string>;redirects?:(site:string)=>Record<string,string>}={}){
 const host=`ownsite-${randomUUID()}.example.test`,site=`https://${host}`,landing=options.source?.(site)??`${site}/`;
 const saved=await tx(()=>saveCandidate(ctx(),{firmName:'Fictional Harbor Property Management',website:landing,sourceUrl:landing,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Tavily Basic search · not verified'}));
 if(!saved.ok)throw Error(saved.reason);
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,$2)',[seed.alpha.workspaceId,options.maxPages??5]);
 const requested=await tx(()=>requestQualification(ctx(true),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
 const pages:Record<string,string>={
  [landing]:'<nav><a href="/services">Services</a><a href="/contact-us">Contact</a><a href="/about-us">About</a><a href="/our-team">Team</a><a href="/contact">Call</a><a href="https://partner.example.test/contact">Partner</a></nav><main><p>Our property management company manages residential homes for owners in Boston.</p></main>',
  [`${site}/contact-us`]:'<main><p>Questions about your rental? Call us at (617) 555-0100.</p></main>',
  [`${site}/about-us`]:'<main><p>Fictional Harbor Property Management has managed rental homes since 2004.</p></main>',
  [`${site}/our-team`]:'<main><p>Our leasing team coordinates tenant maintenance requests.</p></main>',
  [`${site}/contact`]:'<main><p>Second contact page text.</p></main>',
  [`${site}/services`]:'<main><p>Services page text.</p></main>',
  ...options.extra?.(site),
 };
 const requests:string[]=[];
 const provider=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{requests.push(input.url);if(input.url.endsWith('/robots.txt'))return {statusCode:404,headers:{},body:null,abortedOverCap:false};const moved=options.redirects?.(site)[input.url];if(moved)return {statusCode:301,headers:{location:moved},body:null,abortedOverCap:false};const body=pages[input.url];return body===undefined?{statusCode:404,headers:{},body:null,abortedOverCap:false}:html(body);}});
 await runQualification(ctx(true),{runId:requested.value.runId},{pageFetch:provider,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>({ok:false,failureCode:'invalid_evidence',costCents:1})}});
 const stored=async()=>(await runtime.query<{prepared_capture:{pages:{url:string;redirectUrls:string[]}[]}|null;observations:{url:string}[]}>('SELECT prepared_capture,observations FROM sourcing_qualification_runs WHERE id=$1',[requested.value.runId])).rows[0]!;
 return {site,landing,requests,stored,target:{candidateId:saved.value.id,candidateRevision:1,runId:requested.value.runId}};
}

it('ranks a v2 company whose phone is published only on a linked contact page, as the admin list sees it',async()=>{
 const f=await capture();
 expect((await f.stored()).prepared_capture?.pages.map(p=>p.url)).toContain(`${f.site}/contact-us`);
 expect(await tx(()=>refreshCallableRanks(ctx(true)))).toBe(1);
 expect(await ranks()).toEqual([{candidate_id:f.target.candidateId,rank:9,company_host:new URL(f.site).hostname}]);
 const page=await tx(()=>listPreparedProspects(ctx(),{offset:0,order:'callable'}));if(!page.ok)throw Error(page.reason);
 expect(page.value.prospects.map(p=>[p.target.candidateId,p.callable.state,p.callable.phone])).toEqual([[f.target.candidateId,'callable','(617) 555-0100']]);
});

it('ranks nothing when the linked contact page is lost (the association is erased), without a lifecycle or source bypass',async()=>{
 const f=await capture();
 await runtime.query("UPDATE sourcing_qualification_runs SET prepared_capture=NULL WHERE id=$1",[f.target.runId]);
 expect(await tx(()=>refreshCallableRanks(ctx(true)))).toBe(1);
 expect((await ranks())[0]).toMatchObject({rank:null});
});

it('leaves the transaction to its caller: a batch that is rolled back (lost lease) writes no rank row',async()=>{
 const f=await capture();
 await expect(tx(async()=>{expect(await refreshCallableRanks(ctx(true))).toBe(1);throw new Error('lease lost');})).rejects.toThrow('lease lost');
 expect(await ranks()).toEqual([]);
 expect(await tx(()=>refreshCallableRanks(ctx(true)))).toBe(1);expect((await ranks())[0]).toMatchObject({candidate_id:f.target.candidateId,rank:9});
});
