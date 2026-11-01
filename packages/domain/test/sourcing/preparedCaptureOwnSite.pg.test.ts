import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {readPreparedProspect} from '../../sourcing/preparedProspects.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(worker=false)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),runtime);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
const html=(body:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await tx(async()=>{await lockDiscoveryReviewSources(ctx());await runtime.query('DELETE FROM sourcing_candidates');});await runtime.query('DELETE FROM research_settings');await runtime.query('DELETE FROM daily_counters');});
afterAll(async()=>db?.drop());

/** A landing page (the exact candidate source) that links to its own contact, about,
 * team and service pages, a second contact page and another company's site. */
async function capture(options:{maxPages?:number;extra?:(site:string)=>Record<string,string>}={}){
 const host=`ownsite-${randomUUID()}.example.test`,site=`https://${host}`,landing=`${site}/`;
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
 const provider=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{requests.push(input.url);if(input.url.endsWith('/robots.txt'))return {statusCode:404,headers:{},body:null,abortedOverCap:false};const body=pages[input.url];return body===undefined?{statusCode:404,headers:{},body:null,abortedOverCap:false}:html(body);}});
 await runQualification(ctx(true),{runId:requested.value.runId},{pageFetch:provider,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>({ok:false,failureCode:'invalid_evidence',costCents:1})}});
 const stored=async()=>(await runtime.query<{prepared_capture:{pages:{url:string;redirectUrls:string[]}[]}|null;observations:{url:string}[]}>('SELECT prepared_capture,observations FROM sourcing_qualification_runs WHERE id=$1',[requested.value.runId])).rows[0]!;
 return {site,landing,requests,stored,target:{candidateId:saved.value.id,candidateRevision:1,runId:requested.value.runId}};
}

it('associates one linked contact, about and team page with the landing source so the brief cites a contact-page phone',async()=>{
 const f=await capture(),stored=await f.stored();
 expect(f.requests.filter(url=>!url.endsWith('/robots.txt'))).toEqual([f.landing,`${f.site}/contact-us`,`${f.site}/about-us`,`${f.site}/our-team`,`${f.site}/contact`]);
 expect(f.requests.some(url=>url.includes('partner.example.test'))).toBe(false);
 expect(stored.observations.map(o=>o.url)).toEqual([f.landing,`${f.site}/contact-us`,`${f.site}/about-us`,`${f.site}/our-team`,`${f.site}/contact`]);
 expect(stored.prepared_capture?.pages.map(p=>[p.url,p.redirectUrls])).toEqual([
  [`${f.site}/contact-us`,[f.landing,`${f.site}/contact-us`]],[`${f.site}/about-us`,[f.landing,`${f.site}/about-us`]],[`${f.site}/our-team`,[f.landing,`${f.site}/our-team`]]]);
 const brief=await tx(()=>readPreparedProspect(ctx(),f.target));if(!brief.ok)throw Error(brief.reason);
 const cited=new Set(brief.value.passages.map(p=>p.url));
 expect(cited.has(`${f.site}/contact-us`)).toBe(true);expect(cited.has(`${f.site}/contact`)).toBe(false);
 expect(brief.value).toMatchObject({contactAuthority:'not_granted',callable:{state:'callable',phone:'(617) 555-0100'}});
});

it('erases the association when a linked page is lost, leaving only the exact landing source citable',async()=>{
 const f=await capture();
 await tx(async()=>{await lockDiscoveryReviewSources(ctx());await rememberExpiredManualSources(ctx(true),[`${f.site}/contact-us`]);});
 expect((await f.stored()).prepared_capture).toBeNull();
 const brief=await tx(()=>readPreparedProspect(ctx(),f.target));if(!brief.ok)throw Error(brief.reason);
 expect([...new Set(brief.value.passages.map(p=>p.url))]).toEqual([f.landing]);
 expect(brief.value.callable).toMatchObject({state:'not_callable',phone:null});
});

it('keeps model input inside the existing bound by leaving out the lowest-priority extra pages first',async()=>{
 // Eight full pages of whole blocks exceed the 100000-byte observation bound together.
 const full=(label:string)=>`<main>${Array.from({length:60},(_,i)=>`<p>${label} paragraph ${i}: ${'fictional residential management detail '.repeat(5)}</p>`).join('')}</main>`;
 const f=await capture({maxPages:8,extra:site=>({[`${site}/services`]:full('Services'),[`${site}/faq`]:full('FAQ'),[`${site}/tenant-portal`]:full('Tenant'),[`${site}/maintenance`]:full('Maintenance'),[`${site}/careers`]:full('Careers'),
  [`${site}/`]:`<nav><a href="/services">S</a><a href="/faq">F</a><a href="/tenant-portal">T</a><a href="/maintenance">M</a><a href="/careers">C</a><a href="/contact-us">Contact</a><a href="/about-us">About</a><a href="/our-team">Team</a></nav>${full('Landing')}`,
  [`${site}/contact-us`]:`<main><p>Questions about your rental? Call us at (617) 555-0100.</p>${full('Contact').slice(6)}`,[`${site}/about-us`]:full('About'),[`${site}/our-team`]:full('Team')})});
 const stored=await f.stored(),urls=stored.observations.map(o=>o.url);
 expect(Buffer.byteLength(JSON.stringify(stored.observations))).toBeLessThanOrEqual(100000);
 expect(urls.length).toBeLessThan(8);
 expect(urls.slice(0,4)).toEqual([f.landing,`${f.site}/contact-us`,`${f.site}/about-us`,`${f.site}/our-team`]);
 expect(stored.prepared_capture?.pages.map(p=>p.url)).toEqual([`${f.site}/contact-us`,`${f.site}/about-us`,`${f.site}/our-team`]);
});

it('uses a landing page with only navigation and images as lineage, so its contact page phone makes the company callable',async()=>{
 const f=await capture({extra:site=>({[`${site}/`]:'<nav><a href="/contact-us">Contact</a><a href="/about-us"><img src="/logo.png" alt=""></a></nav>',
  [`${site}/about-us`]:'<main><p>Our property management company manages residential homes for owners in Boston.</p></main>'})});
 const stored=await f.stored();
 expect(stored.observations.map(o=>o.url)).not.toContain(f.landing);
 expect(stored.prepared_capture?.pages.map(p=>[p.url,p.redirectUrls])).toEqual([[`${f.site}/contact-us`,[f.landing,`${f.site}/contact-us`]],[`${f.site}/about-us`,[f.landing,`${f.site}/about-us`]]]);
 const brief=await tx(()=>readPreparedProspect(ctx(),f.target));if(!brief.ok)throw Error(brief.reason);
 expect(brief.value.callable).toMatchObject({state:'callable',phone:'(617) 555-0100'});
 expect(brief.value.passages.some(p=>p.url===`${f.site}/contact-us`&&p.kind==='contact')).toBe(true);
});
