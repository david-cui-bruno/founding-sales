import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {repositoryContext,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {requestQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {runQualification} from '@fss/domain/sourcing/qualificationRun.ts';
import {readPreparedProspect} from '@fss/domain/sourcing/preparedProspects.ts';
import {rememberExpiredManualSources} from '@fss/domain/sourcing/manualProspectSourceLoss.ts';
import {researchPageFetch,type RawResponse} from '../../apps/worker/src/research/companyPageFetch.ts';

export const PREPARED_CAPTURE_UPGRADE_WORKFLOW='sourcing.prepared capture (versioned runtime completion and erasure)';
const protectedTables=['firms','contacts','outbound_messages','sequence_enrollments','workspace_settings','research_settings','sourcing_discovery_settings'] as const;
async function effects(ctx:RepositoryContext):Promise<unknown[]>{
 const rows:unknown[]=[];
 for(const table of protectedTables)rows.push((await ctx.db.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`,[ctx.scope.workspaceId])).rows);
 return rows;
}
const response=(text:string,type='text/html'):RawResponse=>({statusCode:200,headers:{'content-type':type},body:new TextEncoder().encode(text),abortedOverCap:false});

/** The upgraded app role performs normal request/capture completion and prepared
 * read on the populated base fixture. Only HTTP/model boundaries are fictional;
 * no validator/call-counter shortcut substitutes for the replaced DB routines. */
export async function runPreparedCaptureUpgradeWorkflow(ctx:RepositoryContext&{db:SessionQueryable}):Promise<string>{
 const identity=(await ctx.db.query<{name:string;runtime:boolean;at:Date}>("SELECT current_database() name,pg_has_role(current_user,'app_runtime','member') runtime,clock_timestamp() at")).rows[0]!;
 assert(identity.name.startsWith('fss_upgrade_')&&identity.runtime,'Prepared capture workflow requires the owned upgraded runtime database');
 const before=await effects(ctx),token=randomUUID(),website=`https://upgrade-capture-${token}.example.test/`,sourceUrl=website+'old-landing',middle=`https://www.upgrade-capture-${token}.example.test/redirect-entry`,final=`https://www.upgrade-capture-${token}.example.test/management`;
 const saved=await withTransaction(ctx.db,()=>saveCandidate(ctx,{firmName:'Home | Fictional upgrade manager',website,sourceUrl,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Controlled retained source; no contact authority.',observedOn:identity.at.toISOString().slice(0,10),preparedBy:'Controlled post-upgrade prepared capture'}));
 assert(saved.ok&&!saved.value.duplicate,'Runtime candidate must be newly saved');
 const requested=await withTransaction(ctx.db,()=>requestQualification(ctx,{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));assert(requested.ok,'Fixture settings must permit one runtime qualification request');
 const runId=requested.value.runId,target={candidateId:saved.value.id,candidateRevision:1,runId};
 const worker=repositoryContext({...ctx.scope,actor:{kind:'system',component:'worker'}},ctx.db);
 const request=(await ctx.db.query<{fingerprint:string}>('SELECT fingerprint FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,runId])).rows[0]!;
 let modelCalls=0;
 const pageFetch=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
  if(input.url.endsWith('/robots.txt'))return response('User-agent: *\nDisallow:\n','text/plain');
  if(input.url===sourceUrl)return {statusCode:301,headers:{location:middle},body:null,abortedOverCap:false};
  if(input.url===middle)return {statusCode:302,headers:{location:final},body:null,abortedOverCap:false};
  if(input.url===final)return response('<main><p>Our property management team manages residential homes and coordinates tenant maintenance requests.</p></main>');
  return {statusCode:404,headers:{},body:null,abortedOverCap:false};
 }});
 await runQualification(worker,{runId},{pageFetch,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async input=>{modelCalls++;assert(!JSON.stringify(input).includes('redirectUrls'));return {ok:false,failureCode:'invalid_evidence',costCents:1};}}});
 const stored=(await ctx.db.query<{fingerprint:string;capture_policy_version:string;prepared_capture:{version:string;sourceUrl:string;pages:{url:string;redirectUrls:string[]}[]};state:string;reason:string}>('SELECT fingerprint,capture_policy_version,prepared_capture,state,reason FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,runId])).rows[0]!;
 assert.equal(stored.capture_policy_version,'prepared-source-association-v2');assert.equal(stored.prepared_capture.version,'prepared-source-association-v2');assert.equal(stored.fingerprint,request.fingerprint);
 assert.equal(stored.state,'unavailable');assert.equal(stored.reason,'invalid_evidence');assert.equal(stored.prepared_capture.sourceUrl,sourceUrl);
 assert.deepEqual(stored.prepared_capture.pages.map(p=>({url:p.url,redirectUrls:p.redirectUrls})),[{url:final,redirectUrls:[sourceUrl,middle,final]}]);
 const read=await withTransaction(ctx.db,()=>readPreparedProspect(ctx,target));assert(read.ok&&read.value.state==='prepared');assert.equal(read.value.contactAuthority,'not_granted');assert(read.value.passages.some(p=>p.url===final&&p.quote.includes('coordinates tenant maintenance requests')));
 // Actual app_runtime mutations must hit the new shape constraint and terminal
 // immutability trigger, then roll back without weakening the retained proof.
 await assert.rejects(withTransaction(ctx.db,()=>ctx.db.query("UPDATE sourcing_qualification_runs SET prepared_capture=prepared_capture||'{\"extra\":true}'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,runId])),{code:'23514',constraint:'sourcing_qualification_prepared_capture_shape'});
 await assert.rejects(withTransaction(ctx.db,()=>ctx.db.query("UPDATE sourcing_qualification_runs SET prepared_capture=jsonb_set(prepared_capture,'{pages,0,contentHash}',to_jsonb(repeat('b',64))) WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,runId])),{code:'23514',constraint:'sourcing_qualification_prepared_capture_immutable'});
 await withTransaction(ctx.db,()=>rememberExpiredManualSources(worker,[middle]));
 assert.equal((await ctx.db.query<{prepared_capture:unknown}>('SELECT prepared_capture FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,runId])).rows[0]!.prepared_capture,null);
 const erased=await withTransaction(ctx.db,()=>readPreparedProspect(ctx,target));assert(erased.ok&&erased.value.state==='needs_research');assert.equal(erased.value.passages.length,0);
 await assert.rejects(withTransaction(ctx.db,()=>ctx.db.query('UPDATE sourcing_qualification_runs SET prepared_capture=$3::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,runId,JSON.stringify(stored.prepared_capture)])),{code:'23514',constraint:'sourcing_qualification_prepared_capture_immutable'});
 assert.equal(modelCalls,1);assert.deepEqual((await ctx.db.query('SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[ctx.scope.workspaceId,runId])).rows,[{state:'settled',settled_cents:1}]);
 assert.deepEqual(await effects(ctx),before);
 return 'runtime request/fake adapter www+path redirects/terminal completion/read exercised v2 shape and immutable trigger; malformed/overwrite/reinstatement refused, intermediate loss erased association, model attempt conserved and settings/CRM/outbound unchanged';
}
