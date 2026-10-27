import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {readProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {readProspectPhoneRefusalOriginal} from '../../sourcing/prospectPhoneRefusalOriginal.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
let db:TestDatabase,runtime:SessionQueryable,seed:TwoWorkspaces,serial=7200;
const ctx=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),session);
const text='🏡 PHONE: <b>Ask the office</b> for help. Whole retained tail.';
beforeAll(async()=>{if(process.env['FSS_PHONE_REFUSAL_ORIGINAL_PG_GRANT']!=='retained-only')throw Error('Fresh Root exclusive PG grant required');db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();expect((await runtime.query('SELECT current_user AS role')).rows[0]?.['role']).toBe('app_runtime');});
afterAll(async()=>db?.drop());
async function fixture({invalidHash=false}:{invalidHash?:boolean}={}){
 const candidate=manualOrdinaryFixture(++serial),saved=await withTransaction(runtime,()=>saveCandidate(ctx(),candidate));if(!saved.ok)throw Error(saved.reason);
 const runId=randomUUID(),observationId=randomUUID(),blocks=[{id:'whole',text}],requestedAt=(await runtime.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
 const content={website:candidate.website!,sourceUrls:[candidate.sourceUrl.replace(/\/+$/u,'')],observations:[]};
 await runtime.query(`INSERT INTO sourcing_prospect_phone_discoveries(workspace_id,id,candidate_id,candidate_revision,creator_user_id,creator_ref,method,state,requested_at,deadline_at,expires_at,content)
 VALUES($1,$2,$3,1,$4,$4,'company-public-phone-v1','pending',$5,$5::timestamptz+interval '30 minutes',$5::timestamptz+interval '1 hour',$6::jsonb)`,[seed.alpha.workspaceId,runId,saved.value.id,seed.alpha.admin.userId,requestedAt,JSON.stringify(content)]);
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='running',dispatched_at=clock_timestamp() WHERE id=$1",[runId]);
 const observation={id:observationId,url:`${candidate.website}contact`,contentHash:createHash('sha256').update(text).digest('hex'),relevantTextHash:invalidHash?'c'.repeat(64):createHash('sha256').update(JSON.stringify(blocks)).digest('hex'),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET state='complete',checked_at=clock_timestamp(),dispatch_finished_at=clock_timestamp(),content=$2::jsonb WHERE id=$1",[runId,JSON.stringify({...content,observations:[observation]})]);
 return {sourceUrl:candidate.sourceUrl,input:{candidateId:saved.value.id,expectedRevision:1,runId,observationId,blockId:'whole',labelStart:3,labelEnd:8,reason:'unattached_label_content' as const}};
}
it('actual app_runtime current composed read returns exactly one whole retained block without creating jobs, receipts or endpoint effects',async()=>{
 const f=await fixture(),before=(await runtime.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows;
 const result=await withTransaction(runtime,()=>readProspectPhoneRefusalOriginal(ctx(),f.input));expect(result).toMatchObject({ok:true,value:{text,candidateId:f.input.candidateId,location:{label:'PHONE',labelStart:3,labelEnd:8},channelAuthority:'not_granted'}});
 expect((await runtime.query('SELECT to_jsonb(j) AS row FROM jobs j ORDER BY id')).rows).toEqual(before);
 const view=await withTransaction(runtime,()=>readProspectPhoneDiscovery(ctx(),f.input));expect(JSON.stringify(view)).not.toContain(text);
});
it.each(['foreign_run','hash','expiry','source','deleted'] as const)('actual retained read refuses %s without any prefix',async mode=>{
 const f=await fixture({invalidHash:mode==='hash'});
 if(mode==='foreign_run')f.input.runId=randomUUID();
 if(mode==='expiry'){
  await runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1",[f.input.runId]);
  await runtime.query('SELECT pg_sleep(0.12)');
 }
 if(mode==='source')await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[f.sourceUrl]));
 if(mode==='deleted')await runtime.query('DELETE FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,f.input.candidateId]);
 const result=await withTransaction(runtime,()=>readProspectPhoneRefusalOriginal(ctx(),f.input));expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain(text);
});
async function waitForLock(pid:number){
 for(let attempt=0;attempt<200;attempt++){
  if((await db.session.query<{waiting:boolean}>("SELECT wait_event_type='Lock' AND wait_event='advisory' waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 throw Error('Expected actual visibility lock wait');
}
it.each(['source','revision','principal'] as const)('real visibility lock wait rechecks %s before exposing original',async mode=>{
 const f=await fixture(),other=await db.appRuntimeSession(),pid=(await runtime.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 await other.query('BEGIN');await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${seed.alpha.workspaceId}`]);
 let permitted=true;const waiting=withTransaction(runtime,()=>readProspectPhoneRefusalOriginal(ctx(),f.input,async()=>permitted));
 try{await waitForLock(pid);if(mode==='source')await rememberExpiredManualSources(ctx(other),[f.sourceUrl]);if(mode==='revision')await other.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[f.input.candidateId]);if(mode==='principal')permitted=false;}finally{await other.query('COMMIT');}
 const result=await waiting;expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain(text);
});
it('source loss at the final principal callback is rechecked after that wait, not exported from earlier originals',async()=>{
 const f=await fixture();let calls=0;
 const result=await withTransaction(runtime,()=>readProspectPhoneRefusalOriginal(ctx(),f.input,async()=>{calls++;if(calls===6)await rememberExpiredManualSources(ctx(),[f.sourceUrl]);return true;}));
 expect(calls).toBeGreaterThanOrEqual(6);expect(result.ok).toBe(false);expect(JSON.stringify(result)).not.toContain(text);
});
