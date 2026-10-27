import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {ProspectPhoneObservation} from '@fss/contracts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {requestProspectPhoneDiscovery,readProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import {listManualProspects} from '@fss/domain/sourcing/manualProspects.ts';
import {prospectPhoneDiscoveryHandler} from '../../apps/worker/src/handlers/prospectPhoneDiscovery.ts';
import {runClaimedJob} from '../../apps/worker/src/runner/jobRunner.ts';

export const PHONE_DISCOVERY_UPGRADE_WORKFLOW='sourcing.phone discovery (complete originals, controlled worker)';
const unchangedTables=['sourcing_qualification_runs','sourcing_admissions','firms','phone_routes','outbound_messages','sequence_enrollments'] as const;
async function effects(context:RepositoryContext):Promise<unknown[]> {
 const result:unknown[]=[];
 for(const table of unchangedTables)result.push((await context.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`,[context.scope.workspaceId])).rows);
 return result;
}

/** Post-upgrade runtime writes and reads, not a direct validator/counter probe.
 * Only the external PageFetch transport is fictional. Existing owner settings,
 * authority, complete-source guards and registered job fencing remain in force. */
export async function runPhoneDiscoveryUpgradeWorkflow(context:RepositoryContext&{db:SessionQueryable}):Promise<string> {
 const database=(await context.db.query<{name:string;role:string;at:Date}>('SELECT current_database() AS name,current_user AS role,clock_timestamp() AS at')).rows[0]!;
 assert(database.name.startsWith('fss_upgrade_'),'Phone upgrade workflow requires its owned disposable database');
 assert.equal((await context.db.query<{runtime:boolean}>("SELECT pg_has_role(current_user,'app_runtime','member') AS runtime")).rows[0]!.runtime,true);
 const before=await effects(context),token=randomUUID(),website=`https://upgrade-phone-${token}.example.test/`;
 const saved=await withTransaction(context.db,()=>saveCandidate(context,{firmName:`Fictional upgrade phone ${token}`,website,locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Fictional complete originals; no qualification or contact authority.',sourceUrl:website+'about',observedOn:database.at.toISOString().slice(0,10),preparedBy:'Controlled post-upgrade workflow'}));
 assert(saved.ok,'Post-upgrade runtime candidate save must succeed');assert.equal(saved.value.duplicate,false);
 const input={candidateId:saved.value.id,expectedRevision:1};
 const requested=await withTransaction(context.db,()=>requestProspectPhoneDiscovery(context,input));
 assert(requested.ok,'Current fixture admin/settings must permit the controlled phone request');
 const runId=requested.value.runId;
 const texts=['FICTIONAL '.repeat(1450)+'Office phone: (214) 555-0123','Office phone: (214) 555-0456',...Array.from({length:99},(_,index)=>`Fictional published context ${index}`)];
 const body=new TextEncoder().encode(texts.map(text=>`<p>${text}</p>`).join(''));
 const contentHash=createHash('sha256').update(body).digest('hex');
 let fetches=0;
 const provider:PageFetchProvider={providerKey:'upgrade-fictional-phone-no-network',fetchPages:async request=>{
  fetches++;assert.equal(request.firmWebsite,website);assert.equal(await request.shouldContinue?.(),true);
  assert(request.mayFetchUrl);assert.equal(await request.mayFetchUrl(website+'contact'),true);
  const at=(await context.db.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString();
  return {ok:true,costCents:0,value:{pages:[{url:website+'contact',body,contentHash,retrievedAt:at,contentType:'text/html',firstParty:true}],skipped:{}}};
 }};
 const registry=new HandlerRegistry().register(prospectPhoneDiscoveryHandler({pageFetch:provider}));
 const claims=await claimJobs(context.db,{owner:`upgrade-phone-${token}`,kinds:registry.kinds(),limit:1,leaseSeconds:180});
 assert.equal(claims.length,1);assert.deepEqual(claims[0]!.payload,{runId});
 assert.equal(await runClaimedJob(context.db,{registry,job:claims[0]!}),'completed');
 const stored=(await context.db.query<{state:string;content:{observations:ProspectPhoneObservation[]}}>('SELECT state,content FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,runId])).rows[0]!;
 assert.equal(stored.state,'complete');assert.equal(stored.content.observations.length,1);
 const original=stored.content.observations[0]!;
 assert.deepEqual(original.blocks,texts.map((text,index)=>({id:`b${index+1}`,text})));
 assert.equal(original.contentHash,contentHash);
 assert.equal(original.relevantTextHash,createHash('sha256').update(JSON.stringify(original.blocks)).digest('hex'));
 const read=await withTransaction(context.db,()=>readProspectPhoneDiscovery(context,input));
 assert(read.ok&&read.value);assert.equal(read.value.runId,runId);assert.equal(read.value.state,'complete');
 assert.equal(read.value.channelAuthority,'not_granted');assert.equal(read.value.phoneEvidence.state,'conflicting');
 if(read.value.phoneEvidence.state!=='conflicting')throw Error('Competing complete originals must not select a survivor');
 assert.deepEqual(read.value.phoneEvidence.sources.map(source=>'normalizedValue' in source?source.normalizedValue:null),['+12145550123','+12145550456']);
 const listed=await withTransaction(context.db,()=>listManualProspects(context,{state:'all',offset:0}));assert(listed.ok);
 const prospect=listed.value.prospects.find(value=>value.candidateId===input.candidateId);assert(prospect);
 assert.equal(prospect.observedPhone,null);assert.equal(prospect.phoneBasis,'unknown');assert.equal(prospect.qualification,'unverified');assert.equal(prospect.contactAuthority,'not_granted');
 const duplicate=await withTransaction(context.db,()=>requestProspectPhoneDiscovery(context,input));assert(duplicate.ok);assert.equal(duplicate.value.runId,runId);assert.equal(fetches,1);
 assert.equal((await context.db.query<{count:number}>('SELECT count(*)::int AS count FROM sourcing_prospect_phone_discoveries WHERE workspace_id=$1 AND candidate_id=$2',[context.scope.workspaceId,input.candidateId])).rows[0]!.count,1);
 assert.deepEqual(await effects(context),before);
 return 'runtime request/registered controlled worker persisted 101 whole blocks including a 14500+ UTF16 block; exact content/text hashes and read/list manual alternatives retained, canonical phone null, no eligibility/CRM/outbound effects or duplicate capture';
}
