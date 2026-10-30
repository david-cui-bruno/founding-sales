import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {z} from 'zod';
import type {ClassifierRequest} from '@fss/domain/classification/prompt.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {preparedSourceIdentityPgFixture} from '../../../packages/domain/test/sourcing/preparedSourceIdentityPgFixture.ts';
import {qualificationExtraction} from '../src/sourcing/qualificationExtraction.ts';
import {sourcingQualificationHandler,sourcingQualificationSource} from '../src/handlers/sourcingQualification.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readAutomaticResearchFirm} from '@fss/domain/sourcing/automaticResearch.ts';
import {readQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {nativeFirmCitations} from '@fss/domain/sourcing/nativeFirmEligibility.ts';
import {PREPARED_IDENTITY_PRODUCER,LEGACY_QUALIFICATION_PRODUCER} from '@fss/domain/sourcing/preparedIdentity.ts';
import {qualificationEvidenceSchema} from '@fss/contracts';

let f:Awaited<ReturnType<typeof preparedSourceIdentityPgFixture>>;
beforeEach(async()=>{f=await preparedSourceIdentityPgFixture();});
afterEach(async()=>f?.drop());
const offeredSchema=z.object({candidate:z.object({firmName:z.string()}),observations:z.array(z.object({id:z.string(),blocks:z.array(z.object({id:z.string(),text:z.string()}))}))});
async function execute(runId:string,options:{competing?:boolean;beforeCount?:()=>Promise<void>;beforeCreate?:()=>Promise<void>}={}){
 let counts=0,creates=0;const counted:ClassifierRequest[]=[],created:ClassifierRequest[]=[];
 const description=`${f.name} manages residential homes in Boston, Massachusetts.`;
 const contact=`Contact ${f.name} office in Boston, MA at info@${new URL(f.website).hostname}.`;
 const pageFetch:PageFetchProvider={providerKey:'company_page',fetchPages:async()=>({ok:true,costCents:0,value:{pages:[
  {url:f.website,contentHash:'a'.repeat(64),contentType:'text/html',body:new TextEncoder().encode(`<h1>${f.name}</h1><p>${description}</p>${options.competing?'<h2>Different Actual Management LLC</h2>':''}`),retrievedAt:new Date().toISOString(),firstParty:true},
  {url:f.website+'contact',contentHash:'c'.repeat(64),contentType:'text/html',body:new TextEncoder().encode(`<p>${contact}</p>`),retrievedAt:new Date().toISOString(),firstParty:true},
 ],skipped:{}}})};
 const extraction=qualificationExtraction({kind:'bedrock',countTokens:async request=>{counts++;counted.push(request);await options.beforeCount?.();return 200;},create:async request=>{
  creates++;created.push(request);
  const committed=await f.database.appRuntimeSession();
  expect((await committed.query('SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[f.workspace,runId])).rows).toEqual([{state:'calling'}]);
  await options.beforeCreate?.();
  const offered=offeredSchema.parse(JSON.parse(String(request.messages[0]?.content)));
  expect(offered.candidate.firmName).toBe(f.label);
  const select=(kind:string,text:string)=>{
   const source=offered.observations.find(s=>s.blocks.some(b=>b.text===text));
   const block=source?.blocks.find(b=>b.text===text);if(!source||!block)throw Error('Controlled source block missing');
   return {kind,observationId:source.id,blockId:block.id};
  };
  const selections=[select('firm_identity',f.name),select('residential_management',description),select('service_area',description),select('business_email',contact)];
  if(options.competing)selections.push(select('firm_identity','Different Actual Management LLC'));
  return {usage:{input_tokens:200,output_tokens:80},content:[{type:'text',text:JSON.stringify({selections,openingQuestion:null})}]};
 }});
 const handler=sourcingQualificationHandler({pageFetch,extraction});
 const input={session:f.runtime,scope:f.worker.scope,job:{id:randomUUID(),workspaceId:f.workspace,kind:'sourcing.qualify',idempotencyKey:'controlled-prepared-identity-'+runId,payload:{runId},attempt:1,maxAttempts:1,fencingToken:'1',leaseOwner:'controlled-fixture',leaseExpiresAt:new Date(Date.now()+180000).toISOString()}};
 await handler.handle(input);
 return {counts,creates,counted,created,replay:()=>handler.handle(input)};
}

it('composes actual search intake, one conserved extraction, immutable label and source-derived automatic current read through app_runtime',async()=>{
 const beforeCandidate=await f.candidateBytes(),beforeHit=await f.hitBytes(),runId=await f.request();
 expect((await f.run(runId)).producer_version).toBe(PREPARED_IDENTITY_PRODUCER);
 const result=await execute(runId);expect(result.counts).toBe(1);expect(result.creates).toBe(1);expect(result.created).toEqual(result.counted);
 await result.replay();expect(result.created).toHaveLength(1);
 const stored=await f.run(runId);expect(stored.prepared_identity).toMatchObject({producerVersion:PREPARED_IDENTITY_PRODUCER,observationId:expect.any(String),blockId:expect.any(String),blockTextHash:expect.stringMatching(/^[a-f0-9]{64}$/u)});
 expect(JSON.stringify(stored.prepared_identity)).not.toContain(f.name);
 const publication=await f.publication();expect(publication).not.toBeNull();
 if(!publication)throw Error('Expected current automatic publication');
 expect(await readAutomaticResearchFirm(f.admin,publication.id)).toMatchObject({firmName:f.name,target:{candidateId:f.candidate.id,runId},channelAuthority:'not_granted',emailFit:'eligible'});
 expect((await f.runtime.query('SELECT name FROM firms WHERE workspace_id=$1 AND id=$2',[f.workspace,publication.firm_id])).rows).toEqual([{name:f.name}]);
 expect(await f.candidateBytes()).toBe(beforeCandidate);expect(await f.hitBytes()).toBe(beforeHit);expect(f.searchCalls).toBe(1);
 expect((await f.runtime.query('SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[f.workspace,runId])).rows).toEqual([{state:'settled',settled_cents:1}]);
 expect((await f.runtime.query('SELECT candidate_id FROM sourcing_admissions WHERE workspace_id=$1',[f.workspace])).rows).toHaveLength(0);
 const legacyInput=qualificationEvidenceSchema.parse({facts:stored.facts,observations:stored.observations});
 expect(nativeFirmCitations({candidate:f.candidate,...legacyInput,now:new Date().toISOString()})).toHaveProperty('status','unavailable');
});

it('refuses competing selected identities after exactly one settled attempt without publication or label correction',async()=>{
 const before=await f.candidateBytes(),runId=await f.request(),result=await execute(runId,{competing:true});
 expect(result.counts).toBe(1);expect(result.creates).toBe(1);
 expect(await f.run(runId)).toMatchObject({state:'unavailable',prepared_identity:null});expect(await f.publication()).toBeNull();expect(await f.candidateBytes()).toBe(before);
 expect((await f.runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[runId])).rows).toEqual([{state:'settled'}]);
});

it.each(['source_loss','owner_revoked'] as const)('does not publish after %s commits during the paid adapter wait, conserving the attempt',async kind=>{
 const runId=await f.request(),result=await execute(runId,{beforeCreate:async()=>{
  if(kind==='source_loss')await f.database.session.query('UPDATE sourcing_discovery_hits SET candidate_id=NULL WHERE workspace_id=$1 AND candidate_id=$2',[f.workspace,f.candidate.id]);
  else await f.deactivateOwner();
 }});
 expect(result.creates).toBe(1);expect(await f.publication()).toBeNull();
 expect((await f.runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[runId])).rows).toEqual([{state:'settled'}]);
 expect((await f.runtime.query('SELECT payload->>\'firmName\' name,revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[f.workspace,f.candidate.id])).rows).toEqual([{name:f.label,revision:1}]);
});

it('a pending legacy producer retains its original refusal and cannot acquire the new interpretation',async()=>{
 const runId=await f.request(f.admin);expect((await f.run(runId)).producer_version).toBe(LEGACY_QUALIFICATION_PRODUCER);
 const result=await execute(runId);expect(result.counts).toBe(1);expect(result.creates).toBe(1);
 expect(await readQualification(f.admin,{candidateId:f.candidate.id})).toMatchObject({runId,status:'unavailable'});
 expect((await f.run(runId)).prepared_identity).toBeNull();expect(await f.publication()).toBeNull();
});

it('advances recovery fairness past twenty-five proof-bearing nonlegacy-region rows without model work or changing their legacy admission verdicts',async()=>{
 await f.runtime.query('DELETE FROM sourcing_candidates WHERE workspace_id=$1',[f.workspace]);
 const runs:string[]=[];
 for(let n=0;n<27;n++){
  const candidate=randomUUID(),run=randomUUID(),prepared=n<26,region=prepared?'CA':'TX',locality=prepared?'Los Angeles':'Dallas';runs.push(run);
  await f.runtime.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[f.workspace,candidate,candidate.replaceAll('-','').padEnd(64,'0'),JSON.stringify({firmName:`Synthetic retained title ${n}`,website:`https://recovery-${n}.example.test/`,sourceUrl:`https://recovery-${n}.example.test/`,locality,region,signal:'fit_only',evidence:'Controlled erased-source recovery row',observedOn:'2026-10-01',preparedBy:'Tavily Basic search · not verified'})]);
  await f.runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,producer_version,requested_at,deadline_at)
   VALUES($1,$2,$3,1,$4,'qualification-context-v7','qualification-v5','claude-haiku-4-5',$5,now()-interval '30 minutes'+$6::integer*interval '1 second',now()+interval '1 minute'+$6::integer*interval '1 second')`,[f.workspace,run,candidate,run.replaceAll('-','').padEnd(64,'0'),prepared?PREPARED_IDENTITY_PRODUCER:LEGACY_QUALIFICATION_PRODUCER,n]);
  // A structurally bound but erased/expired source stays unreadable. Recovery
  // must account for the terminal visit without granting identity or retrying it.
  const proof=prepared?{producerVersion:PREPARED_IDENTITY_PRODUCER,observationId:randomUUID(),blockId:'erased-original',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),blockTextHash:'c'.repeat(64)}:null;
  await f.runtime.query("UPDATE sourcing_qualification_runs SET state='review',prepared_identity=$3::jsonb WHERE workspace_id=$1 AND id=$2",[f.workspace,run,proof===null?null:JSON.stringify(proof)]);
 }
 const current=async()=>(await f.runtime.query<{id:string;admission_checked_at:Date|null;state:string;verdict:unknown;admission_reason:string|null}>('SELECT id,admission_checked_at,state,verdict,admission_reason FROM sourcing_qualification_runs WHERE workspace_id=$1 ORDER BY requested_at,id',[f.workspace])).rows;
 const source=sourcingQualificationSource(true),firstAt=new Date().toISOString();
 expect(await withTransaction(f.runtime,()=>source.find(f.runtime,firstAt))).toEqual([]);
 const first=await current();expect(first.slice(0,25).every(r=>r.admission_checked_at!==null)).toBe(true);expect(first.slice(25).every(r=>r.admission_checked_at===null)).toBe(true);
 expect(first.slice(0,25).every(r=>r.state==='review'&&r.verdict===null&&r.admission_reason===null)).toBe(true);
 expect(await withTransaction(f.runtime,()=>source.find(f.runtime,new Date().toISOString()))).toEqual([]);
 const second=await current();expect(second).toHaveLength(27);expect(second.every(r=>r.admission_checked_at!==null)).toBe(true);
 expect(second.map(r=>r.id)).toEqual(runs);
 expect(second.slice(0,26).every(r=>r.state==='review'&&r.verdict===null&&r.admission_reason===null)).toBe(true);
 expect(second.at(-1)?.admission_reason).toBe('source_incomplete_or_unverified');
 expect((await f.runtime.query('SELECT id FROM provider_reservations WHERE workspace_id=$1',[f.workspace])).rows).toHaveLength(0);
 expect((await f.runtime.query('SELECT candidate_id FROM sourcing_admissions WHERE workspace_id=$1',[f.workspace])).rows).toHaveLength(0);
});
