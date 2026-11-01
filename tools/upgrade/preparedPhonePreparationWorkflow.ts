import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {CallingPreparationInput,ManualPhoneChoice} from '@fss/contracts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {repositoryContext,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {requestProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import {requestQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {runQualification} from '@fss/domain/sourcing/qualificationRun.ts';
import {listManualProspects,recordManualProspectFeedback} from '@fss/domain/sourcing/manualProspects.ts';
import {rememberExpiredManualSources} from '@fss/domain/sourcing/manualProspectSourceLoss.ts';
import {confirmCallingPreparation,readCallingPreparation,requireCurrentCallingPreparation} from '@fss/domain/calling/preparation.ts';
import {lockPreparationCleanup} from '@fss/domain/calling/preparationLifecycle.ts';
import {prospectPhoneDiscoveryHandler} from '../../apps/worker/src/handlers/prospectPhoneDiscovery.ts';
import {runClaimedJob} from '../../apps/worker/src/runner/jobRunner.ts';
import {researchPageFetch,type RawResponse} from '../../apps/worker/src/research/companyPageFetch.ts';

export const PREPARED_PHONE_PREPARATION_UPGRADE_WORKFLOW='calling.preparation (phone-discovery and prepared-capture sources, runtime save/read/erase)';
const untouched=['outbound_messages','sequence_enrollments','contacts','dial_tickets','phone_handoff_attempts','call_sessions'] as const;
async function counts(ctx:RepositoryContext):Promise<number[]>{
 const rows:number[]=[];
 for(const table of untouched)rows.push((await ctx.db.query<{n:number}>(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,[ctx.scope.workspaceId])).rows[0]!.n);
 return rows;
}
const response=(text:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(text),abortedOverCap:false});

/** The upgraded app role saves, reads, re-checks and erases a Calling company from each source kind through the domain
 * commands, so the replaced consistency assertion runs for the phone-discovery branch and the prepared-capture branch.
 * Only the HTTP/model boundaries are fictional; nothing is fetched, sent, reserved or dialled. */
export async function runPreparedPhonePreparationUpgradeWorkflow(ctx:RepositoryContext&{db:SessionQueryable}):Promise<string>{
 const identity=(await ctx.db.query<{name:string;runtime:boolean;at:Date}>("SELECT current_database() name,pg_has_role(current_user,'app_runtime','member') runtime,clock_timestamp() at")).rows[0]!;
 assert(identity.name.startsWith('fss_upgrade_')&&identity.runtime,'Preparation workflow requires the owned upgraded runtime database');
 const before=await counts(ctx),token=randomUUID(),worker=repositoryContext({...ctx.scope,actor:{kind:'system',component:'worker'}},ctx.db),today=identity.at.toISOString().slice(0,10);
 const tx=<T>(work:()=>Promise<T>)=>withTransaction(ctx.db,work);
 const choiceOf=async(candidateId:string):Promise<ManualPhoneChoice>=>{
  const listed=await tx(()=>listManualProspects(ctx,{state:'all',offset:0,candidateId,expectedRevision:1,includeManualPhone:true}));assert(listed.ok);
  const evidence=listed.value.prospects.find(p=>p.candidateId===candidateId)?.phoneEvidence;assert(evidence?.state==='observed');
  const source=evidence.sources.find(item=>'method' in item&&item.normalizedValue!==null);assert(source&&'method' in source);
  const choice={runId:source.runId,observationId:source.observationId,blockId:source.blockId,labelStart:source.labelStart,labelEnd:source.labelEnd,start:source.start,end:source.end,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
  const kept=await tx(()=>recordManualProspectFeedback(ctx,{candidateId,expectedRevision:1,state:'kept',phoneChoice:choice}));assert(kept.ok,'Kept phone choice must be accepted');
  return choice;
 };
 const inputFor=(candidateId:string,choice:ManualPhoneChoice,name:string,website:string):CallingPreparationInput=>({selection:{candidateId,expectedCandidateRevision:1,choice},expected:{state:'absent'},
  reviewedProfile:{companyName:name,website,addressLine:'10 Fictional Office Way',locality:'Dallas',regionCode:'TX',postalCode:'75001',countryCode:'US',timeZone:{kind:'reviewed',timeZone:'America/Chicago'}},acknowledgeUnqualifiedSourceOwnership:true});
 const exercise=async(input:CallingPreparationInput,kind:string,loss:string)=>{
  const saved=await tx(()=>confirmCallingPreparation(ctx,input,async()=>true));assert(saved.ok,`Runtime ${kind} preparation must save`);
  const row=(await ctx.db.query<{source_kind:string;state:string}>('SELECT source_kind,state FROM calling_preparations WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,saved.value.preparationId])).rows[0]!;
  assert.deepEqual(row,{source_kind:kind,state:'live'});
  const read=await tx(()=>readCallingPreparation(ctx,input.selection,async()=>true));assert.equal(read.state,'available');
  await tx(async()=>{await lockPreparationCleanup(ctx);await requireCurrentCallingPreparation(ctx,saved.value.firmId,async()=>true);});
  await tx(async()=>{await lockPreparationCleanup(ctx);await rememberExpiredManualSources(worker,[loss]);});
  const gone=(await ctx.db.query<{state:string;erase_reason:string|null}>('SELECT state,erase_reason FROM calling_preparations WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,saved.value.preparationId])).rows[0]!;
  assert.equal(gone.state,'erased');
  assert.deepEqual((await ctx.db.query('SELECT name,website FROM firms WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,saved.value.firmId])).rows,[{name:'[source unavailable company]',website:null}]);
 };

 // Phone-discovery source: the existing assertion branch, through the controlled worker.
 const discoveryWebsite=`https://upgrade-prep-discovery-${token}.example.test/`,discoveryName='Quillon Harbor Property Management';
 const discovery=await tx(()=>saveCandidate(ctx,{firmName:discoveryName,website:discoveryWebsite,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Fictional complete original; no contact authority.',sourceUrl:discoveryWebsite+'about',observedOn:today,preparedBy:'Controlled post-upgrade preparation'}));
 assert(discovery.ok);
 const requested=await tx(()=>requestProspectPhoneDiscovery(ctx,{candidateId:discovery.value.id,expectedRevision:1}));assert(requested.ok,'Fixture settings must permit one controlled phone request');
 const body=new TextEncoder().encode('<p>Office phone: (972) 555-0147</p>'),contentHash=createHash('sha256').update(body).digest('hex');
 const provider:PageFetchProvider={providerKey:'upgrade-fictional-preparation-no-network',fetchPages:async request=>{
  assert(request.mayFetchUrl);assert.equal(await request.mayFetchUrl(discoveryWebsite+'contact'),true);
  const at=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  return {ok:true,costCents:0,value:{pages:[{url:discoveryWebsite+'contact',body,contentHash,retrievedAt:at,contentType:'text/html',firstParty:true}],skipped:{}}};
 }};
 const registry=new HandlerRegistry().register(prospectPhoneDiscoveryHandler({pageFetch:provider}));
 const claims=await claimJobs(ctx.db,{owner:`upgrade-preparation-${token}`,kinds:registry.kinds(),limit:1,leaseSeconds:180});assert.equal(claims.length,1);
 assert.equal(await runClaimedJob(ctx.db,{registry,job:claims[0]!}),'completed');
 await exercise(inputFor(discovery.value.id,await choiceOf(discovery.value.id),discoveryName,discoveryWebsite),'phone_discovery',discoveryWebsite+'contact');

 // Prepared own-site capture: no discovery run; the capture's redirect hop is the lost source.
 const website=`https://upgrade-prep-capture-${token}.example.test/`,sourceUrl=website+'old-landing',middle=`https://www.upgrade-prep-capture-${token}.example.test/new-entry`,final=`https://www.upgrade-prep-capture-${token}.example.test/contact`,name='Brindle Fjord Property Management';
 const capture=await tx(()=>saveCandidate(ctx,{firmName:name,website,sourceUrl,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Controlled retained source; no contact authority.',observedOn:today,preparedBy:'Controlled post-upgrade preparation'}));assert(capture.ok);
 const qualification=await tx(()=>requestQualification(ctx,{candidateId:capture.value.id,expectedRevision:1},{enqueue:false}));assert(qualification.ok,'Fixture settings must permit a runtime qualification request');
 let modelCalls=0;
 const pageFetch=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
  if(input.url.endsWith('/robots.txt'))return {statusCode:200,headers:{'content-type':'text/plain'},body:new TextEncoder().encode('User-agent: *\nDisallow:\n'),abortedOverCap:false};
  if(input.url===sourceUrl)return {statusCode:301,headers:{location:middle},body:null,abortedOverCap:false};
  if(input.url===middle)return {statusCode:302,headers:{location:final},body:null,abortedOverCap:false};
  if(input.url===final)return response('<main><p>Our property management team manages residential homes and coordinates tenant maintenance requests.</p><p>Office phone: (972) 555-0182</p></main>');
  return {statusCode:404,headers:{},body:null,abortedOverCap:false};
 }});
 await runQualification(worker,{runId:qualification.value.runId},{pageFetch,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>{modelCalls++;return {ok:false,failureCode:'invalid_evidence',costCents:1};}}});
 assert.equal(modelCalls,1);
 await exercise(inputFor(capture.value.id,await choiceOf(capture.value.id),name,website),'prepared_capture',middle);
 assert.deepEqual(await counts(ctx),before);
 return 'runtime phone-discovery and prepared-capture companies saved, previewed, re-checked current and erased by source loss (firm anonymised, route retired); no discovery run for the capture; no outbound, enrollment, contact, ticket, handoff or call effects';
}
