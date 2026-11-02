import {expect,it} from 'vitest';
import type {DiscoveryIntakeSaveInput,ManualPhoneChoice,ManualProspect} from '@fss/contracts';
import {createTestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {manualDiscoveryFixture} from '@fss/domain/test/sourcing/support/manualProspectFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveDiscoveryCandidate,discoveryResearchSeed,discoveryResearchEligibleSql} from '@fss/domain/sourcing/discoveryIntake.ts';
import {listManualProspects,recordManualProspectFeedback} from '@fss/domain/sourcing/manualProspects.ts';
import {readPreparedProspect} from '@fss/domain/sourcing/preparedProspects.ts';
import {readCallingPreparation} from '@fss/domain/calling/preparation.ts';
import {openHold} from '@fss/domain/policy/holds.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {sourcingQualificationHandler,sourcingQualificationSource} from '../src/handlers/sourcingQualification.ts';
import {researchPageFetch} from '../src/research/companyPageFetch.ts';
import {runSchedulerPass} from '../src/scheduler/schedulerPass.ts';
import {runOnce} from '../src/runner/jobRunner.ts';

/** ADR0034: a raw Overture place with its own website is scheduled and researched through the ordinary own-site path. */
type Row={name:string;website:string|null;locality:string|null;region:string|null};
const good=(name:string,website:string|null=`http://${name}.example.test`):Row=>({name,website,locality:'Dallas',region:'TX'});
const business='<p>Our property management company manages residential homes for owners and coordinates tenant maintenance requests.</p>';

async function fixture(ceiling=100){
 const database=await createTestDatabase(),session=await database.appRuntimeSession();
 const {alpha}=await seedTwoWorkspaces(database.session);
 await database.session.query('INSERT INTO research_settings(workspace_id,enabled,daily_firm_ceiling) VALUES($1,true,$2)',[alpha.workspaceId,ceiling]);
 const ctx=(actor:'scheduler'|'admin')=>repositoryContext(workspaceScope(alpha.workspaceId,actor==='admin'?{kind:'user',role:'admin',userId:alpha.admin.userId}:{kind:'system',component:'scheduler'}),session);
 const save=async(row:Row)=>{
  const base=manualDiscoveryFixture(row.name),source={...base.row.source,release:'2026-10-22.0',retrievedAt:'2026-10-23T00:00:00.000Z'};
  const input:DiscoveryIntakeSaveInput={origins:base.origins.map(origin=>({...origin,source})),row:{...base.row,source,observations:[source],firmName:row.name,website:row.website,locality:row.locality,region:row.region}};
  const saved=await withTransaction(session,()=>saveDiscoveryCandidate(ctx('scheduler'),input));
  if(!saved.ok)throw new Error(saved.reason);
  return saved.value.id;
 };
 const pass=()=>runSchedulerPass(session,{sources:[sourcingQualificationSource(true)],now:new Date().toISOString()});
 return {database,session,alpha,ctx,save,pass};
}

it('schedules an Overture place with a website, researches it through the real handler and makes it callable with a phone',async()=>{
 const f=await fixture();try{
  const id=await f.save(good('overture-a'));
  expect(await f.pass()).toMatchObject({outcome:'ran',inserted:1,externalActions:0});
  const run=(await f.session.query<{id:string;candidate_id:string;state:string}>('SELECT id,candidate_id,state FROM sourcing_qualification_runs')).rows;
  expect(run).toMatchObject([{candidate_id:id,state:'pending'}]);
  const requested:string[]=[];
  const pageFetch=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
   requested.push(input.url);
   if(input.url.endsWith('/robots.txt'))return {statusCode:200,headers:{'content-type':'text/plain'},body:new TextEncoder().encode('User-agent: *\nDisallow:\n'),abortedOverCap:false};
   // The business context is on the landing page and the phone on a linked contact page: each is admitted through its own association.
   if(input.url==='https://overture-a.example.test/')return {statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(`<main>${business}<a href="/contact">Contact us</a></main>`),abortedOverCap:false};
   if(input.url==='https://overture-a.example.test/contact')return {statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode('<main><p>Office phone: (214) 555-0147</p></main>'),abortedOverCap:false};
   return {statusCode:404,headers:{},body:null,abortedOverCap:false};
  }});
  const registry=new HandlerRegistry().register(sourcingQualificationHandler({pageFetch,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>({ok:false,failureCode:'invalid_evidence',costCents:1})}}));
  expect(await runOnce(f.session,{registry,owner:'overture-research-test',limit:5})).toMatchObject({failed:0});
  // The http reference was read as https; only the company's own site was requested.
  expect(requested.filter(url=>!url.endsWith('/robots.txt')).sort()).toEqual(['https://overture-a.example.test/','https://overture-a.example.test/contact']);
  expect((await f.session.query('SELECT state FROM sourcing_qualification_runs WHERE id=$1',[run[0]!.id])).rows[0]).not.toMatchObject({state:'pending'});

  const target={candidateId:id,candidateRevision:1,runId:run[0]!.id};
  const brief=await withTransaction(f.session,()=>readPreparedProspect(f.ctx('admin'),target));
  expect(brief).toMatchObject({ok:true,value:{state:'prepared',callable:{state:'callable',missing:[],phone:'(214) 555-0147'},website:'http://overture-a.example.test/',companyHost:'overture-a.example.test'}});

  // Calling's prepared phone: the exact number the brief cites is choosable, kept, and readable by Calling without a phone-discovery run.
  const listed=await withTransaction(f.session,()=>listManualProspects(f.ctx('admin'),{state:'all',offset:0,candidateId:id,expectedRevision:1,includeManualPhone:true}));
  if(!listed.ok)throw new Error(listed.reason);
  const prospect:ManualProspect=listed.value.prospects.find(p=>p.candidateId===id)!;
  const evidence=prospect.phoneEvidence;
  if(evidence?.state!=='observed')throw new Error(`phone evidence ${evidence?.state}`);
  const source=evidence.sources.find(item=>'method' in item);if(!source||!('method' in source))throw new Error('no literal source');
  expect(evidence).toMatchObject({value:'+12145550147',sources:[{authority:{kind:'prepared_capture'}}]});
  const choice:ManualPhoneChoice={runId:source.runId,observationId:source.observationId,blockId:source.blockId,labelStart:source.labelStart,labelEnd:source.labelEnd,start:source.start,end:source.end,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
  expect(await withTransaction(f.session,()=>recordManualProspectFeedback(f.ctx('admin'),{candidateId:id,expectedRevision:1,state:'kept',phoneChoice:choice}))).toMatchObject({ok:true,value:{state:'kept'}});
  expect(await withTransaction(f.session,()=>readCallingPreparation(f.ctx('admin'),{candidateId:id,expectedCandidateRevision:1,choice},async()=>true))).toMatchObject({state:'available',phone:{value:'+12145550147'},contactAuthority:'not_granted'});

  // The retained candidate is untouched and nothing canonical was created or authorized.
  expect((await f.session.query<{payload:{kind:string};revision:number;status:string}>('SELECT payload,revision,status FROM sourcing_candidates')).rows).toMatchObject([{payload:{kind:'discovery-v1'},revision:1,status:'needs_review'}]);
  for(const table of ['firms','contacts','sourcing_admissions','phone_routes','dial_tickets','outbound_messages'])expect((await f.session.query(`SELECT 1 FROM ${table}`)).rows).toHaveLength(0);
  // Researched once: the next pass has nothing due.
  expect(await f.pass()).toMatchObject({inserted:0});
 }finally{await f.database.drop();}
});

it('does not schedule an Overture place without a usable website, place or support, nor one the user skipped',async()=>{
 const f=await fixture();try{
  await f.save(good('no-website',null));
  await f.save(good('bare-host','bare-host.example.test'));
  await f.save({...good('no-locality'),locality:null});
  await f.save({...good('no-region'),region:null});
  await f.save({...good('canada'),region:'ON'});
  await f.save(good('port','https://port.example.test:8443/'));
  await f.save(good('local-host','https://printer.local/'));
  const skipped=await f.save(good('skipped'));
  const dismissed=await f.save(good('dismissed'));
  await f.session.query("INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state) VALUES($1,$2,1,'skipped')",[f.alpha.workspaceId,skipped]);
  await f.session.query("UPDATE sourcing_candidates SET status='dismissed' WHERE id=$1",[dismissed]);
  expect(await f.pass()).toMatchObject({inserted:0,externalActions:0});
  expect((await f.session.query('SELECT 1 FROM sourcing_qualification_runs')).rows).toHaveLength(0);
  expect((await f.session.query('SELECT 1 FROM jobs')).rows).toHaveLength(0);
  // The scheduling predicate admits only what the research seed accepts, so a refused row can never hold the queue head.
  const rows=(await f.session.query<{id:string;payload:unknown}>('SELECT id,payload FROM sourcing_candidates')).rows;
  const eligible=(await f.session.query<{id:string}>(`SELECT c.id FROM sourcing_candidates c WHERE ${discoveryResearchEligibleSql('c')}`)).rows;
  expect(eligible).toEqual([]);
  expect(rows.filter(row=>discoveryResearchSeed(row.payload)!==null).map(row=>row.id).sort()).toEqual([skipped,dismissed].sort());
 }finally{await f.database.drop();}
});

it('keeps the scheduling predicate inside the research seed for schemed websites',async()=>{
 const f=await fixture();try{
  const websites=['https://a.example.test','http://www.b.example.test/contact?x=1','HTTP://C.EXAMPLE.TEST/','https://d.example.test/'+'p'.repeat(470),' https://e.example.test/ ','https://f.example.test:81/','https://user@g.example.test/','https://h.example','ftp://i.example.test/','https://x.example.local'];
  const ids=new Map<string,string>();
  for(const [index,website] of websites.entries())ids.set(await f.save(good(`agree-${index}`,website)),website);
  const rows=(await f.session.query<{id:string;payload:unknown}>('SELECT id,payload FROM sourcing_candidates')).rows;
  const eligible=new Set((await f.session.query<{id:string}>(`SELECT c.id FROM sourcing_candidates c WHERE ${discoveryResearchEligibleSql('c')}`)).rows.map(row=>row.id));
  expect(rows).toHaveLength(websites.length);
  // Never admit a row the seed refuses; the 490-character bound is deliberately a little tighter than the schema's.
  for(const row of rows)if(eligible.has(row.id))expect(discoveryResearchSeed(row.payload),ids.get(row.id)).not.toBeNull();
  expect([...eligible].map(id=>ids.get(id)).sort()).toEqual([websites[0],websites[1],websites[2],websites[4],websites[7]].sort());
  expect(rows.filter(row=>discoveryResearchSeed(row.payload)===null).map(row=>ids.get(row.id)).sort()).toEqual([websites[5],websites[6],websites[8],websites[9]].sort());
  expect(discoveryResearchSeed(rows.find(row=>ids.get(row.id)===websites[2])!.payload)).toMatchObject({website:'https://c.example.test/',sourceUrl:'https://c.example.test/',region:'TX',locality:'Dallas'});
 }finally{await f.database.drop();}
});

it('still stops scheduling at the daily firm ceiling and under a research hold',async()=>{
 const f=await fixture(2);try{
  for(const name of ['ceiling-a','ceiling-b','ceiling-c'])await f.save(good(name));
  expect(await f.pass()).toMatchObject({inserted:2});
  expect((await f.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings')).rows).toEqual([{qualification_wait_reason:'daily_firm_ceiling'}]);
  expect(await f.pass()).toMatchObject({inserted:0});
  expect((await f.session.query('SELECT 1 FROM sourcing_qualification_runs')).rows).toHaveLength(2);
 }finally{await f.database.drop();}
});

it('does not schedule an Overture place while research is held or disabled',async()=>{
 const f=await fixture();try{
  await f.save(good('held'));
  await withTransaction(f.session,()=>openHold(f.ctx('scheduler'),{scopeKind:'workspace',reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'fixture'}));
  expect(await f.pass()).toMatchObject({inserted:0});
  expect((await f.session.query('SELECT qualification_wait_reason FROM sourcing_discovery_settings')).rows).toEqual([{qualification_wait_reason:'research_held'}]);
  expect((await f.session.query('SELECT 1 FROM sourcing_qualification_runs')).rows).toHaveLength(0);
 }finally{await f.database.drop();}
});
