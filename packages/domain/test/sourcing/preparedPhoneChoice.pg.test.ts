import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import type {ManualPhoneChoice,ManualProspect} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {readPreparedProspect} from '../../sourcing/preparedProspects.ts';
import {listManualProspects,recordManualProspectFeedback,currentManualPhoneChoiceAuthority} from '../../sourcing/manualProspects.ts';
import {readCallingPreparation} from '../../calling/preparation.ts';
import {researchPageFetch,type RawResponse} from '../../../../apps/worker/src/research/companyPageFetch.ts';
import {lockDiscoveryReviewSources} from '../../sourcing/discoveryReviewVisibility.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {withPreparedSourceDeadlines} from '../../sourcing/preparedSourceDeadlines.ts';
import type {ManualPhoneSnapshot} from '../../sourcing/manualProspectPhone.ts';
import type {ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(session=runtime,worker=false)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,worker?{kind:'system',component:'worker'}:{kind:'user',role:'admin',userId:seed.alpha.admin.userId}),session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(runtime,fn);
const response=(body:string):RawResponse=>({statusCode:200,headers:{'content-type':'text/html'},body:new TextEncoder().encode(body),abortedOverCap:false});
const business='<p>Our property management company manages residential homes for owners and coordinates tenant maintenance requests.</p>';
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{
 await tx(async()=>{await lockDiscoveryReviewSources(ctx());await runtime.query('DELETE FROM sourcing_candidates');});
 for(const table of ['evidence_items','provider_reservations','provider_ledger','research_settings','daily_counters'])await runtime.query(`DELETE FROM ${table}`);
});
afterAll(async()=>db?.drop());

/** A real redirected own-site capture whose final page carries the supplied blocks. */
async function captured(page:string){
 const domain=`phone-${randomUUID()}.example.test`,website=`https://${domain}/`,sourceUrl=website+'old-landing',middle=`https://www.${domain}/new-entry`,final=`https://www.${domain}/contact`;
 const saved=await tx(()=>saveCandidate(ctx(),{firmName:'Capture Property Management',website,sourceUrl,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional search label only',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled redirect fixture'}));
 if(!saved.ok)throw Error(saved.reason);
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,max_pages_per_firm) VALUES($1,true,1)',[seed.alpha.workspaceId]);
 const requested=await tx(()=>requestQualification(ctx(runtime,true),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
 const provider=researchPageFetch({lookup:async()=>['93.184.216.34'],request:async input=>{
  if(input.url.endsWith('/robots.txt'))return {statusCode:200,headers:{'content-type':'text/plain'},body:new TextEncoder().encode('User-agent: *\nDisallow:\n'),abortedOverCap:false};
  if(input.url===sourceUrl)return {statusCode:301,headers:{location:middle},body:null,abortedOverCap:false};
  if(input.url===middle)return {statusCode:302,headers:{location:final},body:null,abortedOverCap:false};
  if(input.url===final)return response(`<main>${business}${page}</main>`);
  return {statusCode:404,headers:{},body:null,abortedOverCap:false};
 }});
 const target={candidateId:saved.value.id,candidateRevision:1,runId:requested.value.runId};
 await runQualification(ctx(runtime,true),target,{pageFetch:provider,extraction:{providerKey:'aws_bedrock.sourcing_qualification',countInputTokens:async()=>100,extract:async()=>({ok:false,failureCode:'invalid_evidence',costCents:1})}});
 return {target,candidateId:saved.value.id,final};
}
const list=(candidateId:string,includeManualPhone=true)=>tx(()=>listManualProspects(ctx(),{state:'all',offset:0,candidateId,expectedRevision:1,...(includeManualPhone?{includeManualPhone:true}:{})}));
const only=async(candidateId:string,includeManualPhone=true):Promise<ManualProspect>=>{const answer=await list(candidateId,includeManualPhone);if(!answer.ok)throw Error(answer.reason);const found=answer.value.prospects.find(p=>p.candidateId===candidateId);if(!found)throw Error('missing prospect');return found;};
const choiceFrom=(prospect:ManualProspect,pick:(source:{label:string;literal:string})=>boolean=()=>true):ManualPhoneChoice=>{
 const evidence=prospect.phoneEvidence;if(evidence?.state!=='observed'&&evidence?.state!=='conflicting')throw Error('no phone evidence');
 const source=evidence.sources.find(item=>'method' in item&&item.normalizedValue!==null&&pick(item));if(!source||!('method' in source))throw Error('no literal source');
 return {runId:source.runId,observationId:source.observationId,blockId:source.blockId,labelStart:source.labelStart,labelEnd:source.labelEnd,start:source.start,end:source.end,contentHash:source.contentHash,relevantTextHash:source.relevantTextHash};
};
const keep=(candidateId:string,phoneChoice:ManualPhoneChoice)=>tx(()=>recordManualProspectFeedback(ctx(),{candidateId,expectedRevision:1,state:'kept',phoneChoice}));

it('shows and keeps a prepared own-site labelled phone for the exact candidate without a phone-discovery run',async()=>{
 const f=await captured('<p>Office phone: (614) 725-3059</p>');
 const brief=await tx(()=>readPreparedProspect(ctx(),f.target));
 expect(brief).toMatchObject({ok:true,value:{callable:{state:'callable',phone:'(614) 725-3059'}}});
 // The default queue read is unchanged; only Calling's opted-in read adds the prepared association.
 expect((await only(f.candidateId,false)).phoneEvidence).toMatchObject({state:'not_extracted',reason:'original_not_usable'});
 const prospect=await only(f.candidateId);
 expect(prospect.phoneEvidence).toMatchObject({state:'observed',value:'+16147253059',coverage:{parser:'manual-literal-phone-v2'},
  sources:[{method:'retained_original_literal',url:f.final,literal:'(614) 725-3059',label:'Office phone',authority:{kind:'prepared_capture',sourceUrl:f.final}}]});
 expect(prospect.manualPhone).toBeUndefined();
 const choice=choiceFrom(prospect);
 expect(await keep(f.candidateId,choice)).toMatchObject({ok:true,value:{state:'kept',phoneChoice:choice}});
 const chosen=await only(f.candidateId);
 expect(chosen.manualPhone).toMatchObject({value:'+16147253059',choice,sourceUrl:f.final});
 // The route re-checks after the receipt inside the same transaction, which still holds the source lifecycle.
 await tx(async()=>{
  expect(await recordManualProspectFeedback(ctx(),{candidateId:f.candidateId,expectedRevision:1,state:'kept',phoneChoice:choice})).toMatchObject({ok:true});
  await currentManualPhoneChoiceAuthority(ctx(),{candidateId:f.candidateId,expectedRevision:1,phoneChoice:choice},async()=>true);
 });
 expect((await runtime.query('SELECT manual_phone_choice FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[f.candidateId])).rows).toEqual([{manual_phone_choice:choice}]);
});
it('shows and keeps a standalone published number as its own label',async()=>{
 const f=await captured('<p>(614) 725-3059</p>');
 const prospect=await only(f.candidateId);
 expect(prospect.phoneEvidence).toMatchObject({state:'observed',value:'+16147253059',sources:[{label:'(614) 725-3059',authority:{kind:'prepared_capture'}}]});
 const choice=choiceFrom(prospect);expect(choice.labelStart).toBe(choice.start);expect(choice.labelEnd).toBe(choice.end);
 expect(await keep(f.candidateId,choice)).toMatchObject({ok:true});
 expect((await only(f.candidateId)).manualPhone).toMatchObject({value:'+16147253059',choice});
});
it.each([['fax and cell wording','<p>Fax: (614) 725-3060</p><p>Call (614) 725-3059 or text us</p>'],['unsupported suffix','<p>Office phone: (614) 725-3059 ext 12</p>']])('keeps the refusals for a prepared page with %s',async(_name,page)=>{
 const f=await captured(page);
 const prospect=await only(f.candidateId);
 expect(prospect.phoneEvidence?.state).not.toBe('observed');
 const evidence=prospect.phoneEvidence;
 if(evidence?.state==='conflicting'){
  const literal=evidence.sources.find(item=>'method' in item);
  if(literal&&'method' in literal)expect(await keep(f.candidateId,{runId:literal.runId,observationId:literal.observationId,blockId:literal.blockId,labelStart:literal.labelStart,labelEnd:literal.labelEnd,start:literal.start,end:literal.end,contentHash:literal.contentHash,relevantTextHash:literal.relevantTextHash})).toMatchObject({ok:false,reason:'phone_source_changed'});
 }
 expect((await runtime.query('SELECT 1 FROM sourcing_manual_prospect_states WHERE candidate_id=$1 AND manual_phone_choice IS NOT NULL',[f.candidateId])).rows).toEqual([]);
});
it('stops offering and refuses to keep the phone once its source is withdrawn, and the kept choice stops projecting',async()=>{
 const f=await captured('<p>Office phone: (614) 725-3059</p>');
 const choice=choiceFrom(await only(f.candidateId));expect(await keep(f.candidateId,choice)).toMatchObject({ok:true});
 await tx(async()=>{await lockDiscoveryReviewSources(ctx());await rememberExpiredManualSources(ctx(runtime,true),[f.final]);});
 const after=await only(f.candidateId);
 expect(after.phoneEvidence?.state).not.toBe('observed');expect(after.manualPhone).toBeUndefined();
 expect(await keep(f.candidateId,choice)).toMatchObject({ok:false,reason:'phone_source_changed'});
 await expect(tx(async()=>{await lockDiscoveryReviewSources(ctx());await currentManualPhoneChoiceAuthority(ctx(),{candidateId:f.candidateId,expectedRevision:1,phoneChoice:choice},async()=>true);})).rejects.toMatchObject({reason:'phone_source_changed'});
});
it('refuses a stale or foreign choice and saves nothing',async()=>{
 const f=await captured('<p>Office phone: (614) 725-3059</p>');
 const choice=choiceFrom(await only(f.candidateId));
 for(const change of [{contentHash:'b'.repeat(64)},{blockId:'zz'},{start:choice.start+1},{observationId:randomUUID()}])
  expect(await keep(f.candidateId,{...choice,...change})).toMatchObject({ok:false,reason:'phone_source_changed'});
 expect((await runtime.query('SELECT 1 FROM sourcing_manual_prospect_states WHERE candidate_id=$1 AND manual_phone_choice IS NOT NULL',[f.candidateId])).rows).toEqual([]);
});
it('leaves Calling preparation to its own checks: a prepared-page choice creates no company, route or call',async()=>{
 const f=await captured('<p>Office phone: (614) 725-3059</p>');
 const choice=choiceFrom(await only(f.candidateId));await keep(f.candidateId,choice);
 const counts=async()=>(await runtime.query<{n:string}>(`SELECT (SELECT count(*) FROM calling_preparations)+(SELECT count(*) FROM firms)+(SELECT count(*) FROM phone_routes)+(SELECT count(*) FROM dial_tickets) AS n`)).rows[0]!.n;
 const before=await counts();
 expect(await tx(()=>readCallingPreparation(ctx(),{candidateId:f.candidateId,expectedCandidateRevision:1,choice},async()=>true))).toMatchObject({state:'refused',reason:'source_withdrawn'});
 expect(await counts()).toBe(before);
});
it('attaches the earliest retained-evidence expiry of each permitted page from the shared prepared-source collection',async()=>{
 const f=await captured('<p>Office phone: (614) 725-3059</p>'),expires=new Date(Date.now()+60_000),page='https://auxiliary.example.test/team';
 const firm=(await runtime.query<{id:string}>("INSERT INTO firms(workspace_id,name) VALUES($1,'Fictional page grant') RETURNING id",[seed.alpha.workspaceId])).rows[0]!.id;
 await tx(async()=>{await lockDiscoveryReviewSources(ctx());for(const at of [expires,new Date(Date.now()+3_600_000)])await runtime.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'fixture',$3,$4,true,$5)",[seed.alpha.workspaceId,firm,page+'/',`${at.getTime()}`.padEnd(64,'a'),at]);});
 const snapshot={permitted_urls:[page],candidate_id:f.candidateId} as unknown as ManualPhoneSnapshot,row={id:f.candidateId} as unknown as ManualProspectRow;
 const [decorated]=await tx(()=>withPreparedSourceDeadlines(ctx(),[row],[snapshot]));
 expect(decorated?.['prepared_source_deadlines']).toEqual({[page]:expires.getTime()});
});
