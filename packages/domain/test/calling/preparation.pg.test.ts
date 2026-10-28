import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {callingPreparationFixture} from './preparationFixture.ts';
import {confirmCallingPreparation,readCallingPreparation} from '../../calling/preparation.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
import {enqueueFirmResearch} from '../../research/enqueue.ts';
import {firmIsResearchable} from '../../research/firmState.ts';
import {createFirm} from '../../crm/firms.ts';
import {previewDeletion,commitDeletion,REDACTED_NAME} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
let f:Awaited<ReturnType<typeof callingPreparationFixture>>;
beforeAll(async()=>{f=await callingPreparationFixture();});
afterAll(async()=>{await f?.stop();});
it('creates a source-bound unqualified company with real research pause before ordinary enqueue and no acquisition',async()=>{
 const source=await f.source(),before=(await f.runtime.query('SELECT id FROM jobs')).rows;
 const preview=await f.tx(()=>readCallingPreparation(f.ctx(),source.input.selection,async()=>true));expect(preview).toMatchObject({state:'available',binding:null,researchPolicy:'required_before_enqueue'});
 const result=await f.tx(()=>confirmCallingPreparation(f.ctx(),source.input,async()=>true));expect(result).toMatchObject({ok:true});if(!result.ok)throw Error(result.reason);
 const p=result.value;
 expect((await f.runtime.query('SELECT technical_validation,association_confidence,eligibility,contact_id FROM phone_routes WHERE id=$1',[p.routeId])).rows)
  .toEqual([{technical_validation:'unknown',association_confidence:null,eligibility:'candidate',contact_id:null}]);
 expect((await f.runtime.query('SELECT id FROM jobs')).rows).toEqual(before);
 expect(await f.tx(()=>enqueueFirmResearch(f.ctx(),{firmId:p.firmId,trigger:'user_request'}))).toMatchObject({ok:false,reason:'research_disabled'});
 expect(await firmIsResearchable(f.ctx(),p.firmId)).toMatchObject({ok:false,reason:'research_disabled'});
 for(const table of ['contacts','opportunities','sequence_enrollments','provider_reservations','call_sessions'])expect((await f.runtime.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[f.seed.alpha.workspaceId])).rows).toEqual([]);
 expect(await f.tx(()=>readCallingPreparation(f.ctx(),source.input.selection,async()=>true))).toMatchObject({state:'available',binding:{preparationId:p.preparationId},researchPolicy:'paused_before_enqueue'});
});
it('rejects a state-only erased transition that leaves profile/endpoint bytes and rejects a second Firm stealing the marker',async()=>{
 const p=await f.prepared();
 await expect(f.tx(()=>f.runtime.query(`UPDATE calling_preparations SET state='erased',revision=revision+1,erased_at=clock_timestamp(),updated_at=clock_timestamp(),
  erase_reason='source_deleted',choice=NULL,source_url_hashes=NULL,profile_hash=NULL WHERE id=$1`,[p.preparationId]))).rejects.toMatchObject({code:'23514'});
 expect((await f.runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'live'}]);
 await expect(f.tx(()=>f.runtime.query("INSERT INTO firms(workspace_id,name,calling_preparation_id) VALUES($1,'Stolen prepared identity',$2)",[f.seed.alpha.workspaceId,p.preparationId]))).rejects.toMatchObject({code:'23514'});
});
it('physically erases exact owned profile/route, keeps permanent identity, and cannot restore bytes or create another preparation',async()=>{
 const p=await f.prepared();
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[f.seed.alpha.workspaceId,p.preparationId]);});
 expect((await f.runtime.query('SELECT name,website,address_line,locality,region_code,postal_code,country_code,time_zone FROM firms WHERE id=$1',[p.firmId])).rows)
  .toEqual([{name:'[source unavailable company]',website:null,address_line:null,locality:null,region_code:null,postal_code:null,country_code:'ZZ',time_zone:null}]);
 expect((await f.runtime.query('SELECT e164,eligibility,version FROM phone_routes WHERE id=$1',[p.routeId])).rows).toEqual([{e164:null,eligibility:'retired',version:2}]);
 await expect(f.tx(()=>f.runtime.query('UPDATE phone_routes SET e164=$2,version=version+1 WHERE id=$1',[p.routeId,'+12145550123']))).rejects.toMatchObject({code:'23514'});
 expect(await f.tx(()=>confirmCallingPreparation(f.ctx(),p.input,async()=>true))).toMatchObject({ok:false,reason:'preparation_terminal'});
 expect(await f.tx(()=>readCallingPreparation(f.ctx(),p.input.selection,async()=>true))).toEqual({state:'withdrawn',preparationId:p.preparationId,revision:2,reason:'source_withdrawn'});
});
it('keeps ordinary independently authored companies unchanged by source-only erasure and refuses known duplicate Recorded selection',async()=>{
 const source=await f.source(),independent=await f.tx(()=>createFirm(f.ctx(),{name:source.raw.firmName,website:source.raw.website,assignedUserId:f.seed.alpha.admin.userId}));if(!independent.ok)throw Error(independent.reason);
 expect(await f.tx(()=>confirmCallingPreparation(f.ctx(),source.input,async()=>true))).toMatchObject({ok:false,reason:'duplicate_recorded_company'});
 expect((await f.runtime.query('SELECT name,website,calling_preparation_id FROM firms WHERE id=$1',[independent.value.id])).rows).toEqual([{name:source.raw.firmName,website:source.raw.website,calling_preparation_id:null}]);
});
it('preserves existing registered whole-Firm deletion after source erasure and retains the denial tombstone',async()=>{
 const p=await f.prepared();
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[f.seed.alpha.workspaceId,p.preparationId]);});
 const preview=await f.tx(()=>previewDeletion(f.ctx(),{targetKind:'firm',firmId:p.firmId}));if(!preview.ok)throw Error(preview.reason);
 const result=await f.tx(()=>commitDeletion(f.ctx(),{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()}));
 expect(result).toMatchObject({ok:true});
 expect((await f.runtime.query('SELECT name,country_code FROM firms WHERE id=$1',[p.firmId])).rows).toEqual([{name:REDACTED_NAME,country_code:'ZZ'}]);
 expect((await f.runtime.query('SELECT state FROM calling_preparations WHERE id=$1',[p.preparationId])).rows).toEqual([{state:'erased'}]);
});
it('app_runtime cannot omit/duplicate route ownership, grant qualification, launder aliases or release the research-only pause',async()=>{
 const p=await f.prepared(),w=f.seed.alpha.workspaceId;
 const attempts:[string,readonly unknown[]][]=[
  ["INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at) VALUES($1,$2,'+14015550199','website',clock_timestamp())",[w,p.firmId]],
  ["INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,calling_preparation_id) VALUES($1,$2,'+14015550199','website',clock_timestamp(),$3)",[w,p.firmId,p.preparationId]],
  ["UPDATE phone_routes SET technical_validation='passed',version=version+1 WHERE id=$1",[p.routeId]],
  ["UPDATE phone_routes SET association_confidence=1,version=version+1 WHERE id=$1",[p.routeId]],
  ["INSERT INTO record_aliases(workspace_id,firm_id,record_kind,alias_kind,alias_value) VALUES($1,$2,'firm','name','Independent-looking alias')",[w,p.firmId]],
  ["UPDATE active_holds SET released_at=clock_timestamp() WHERE source_event_kind='calling_preparation' AND source_event_id=$1",[p.preparationId]],
 ];
 for(const [sql,values] of attempts)await expect(f.tx(()=>f.runtime.query(sql,values))).rejects.toMatchObject({code:'23514'});
 expect((await f.runtime.query('SELECT e164,technical_validation,association_confidence,version FROM phone_routes WHERE id=$1',[p.routeId])).rows).toEqual([{e164:expect.any(String),technical_validation:'unknown',association_confidence:null,version:1}]);
});
