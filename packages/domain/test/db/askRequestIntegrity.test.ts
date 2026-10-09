import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
let database:TestDatabase;let seeded:TwoWorkspaces;
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);});
afterAll(async()=>{await database.drop();});
it('refuses changing a retained request initial source closure',async()=>{
 const id=randomUUID(),sourceId=randomUUID();
 const scope={sources:[{workspaceId:seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null}]};
 await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'What was promised?',$4::jsonb,'[]','{"firmIds":[],"personIds":[]}','unavailable','purpose_unavailable')`,[seeded.alpha.workspaceId,id,seeded.alpha.salesperson.userId,JSON.stringify(scope)]);
 await expect(database.session.query('UPDATE crm_ask_requests SET initial_access_closure=$3::jsonb WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,id,JSON.stringify({firmIds:[randomUUID()],personIds:[]})])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_initial_identity_immutable'});
});
it('refuses attaching canonical Ask window proof to another workspace request',async()=>{
 const id=randomUUID(),sourceId=randomUUID();
 const scope={sources:[{workspaceId:seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null}]};
 await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'What was promised?',$4::jsonb,'[]','{"firmIds":[],"personIds":[]}','unavailable','purpose_unavailable')`,[seeded.alpha.workspaceId,id,seeded.alpha.salesperson.userId,JSON.stringify(scope)]);
 await expect(database.session.query(`INSERT INTO crm_ask_request_windows(workspace_id,request_id,request_version,request_epoch,ordinal,source_kind,source_id,source_revision,source_hash,locator,context_hash,text_hash,group_hash,context_snapshot,original_access_closure) VALUES($1,$2,1,1,1,'selected_note',$3,1,$4,'text:0:10',$4,$4,$4,'{"personId":null,"firmIds":[],"relationships":[],"review":"current"}','{"firmIds":[],"personIds":[]}')`,[seeded.beta.workspaceId,id,sourceId,'a'.repeat(64)])).rejects.toMatchObject({code:'23503',constraint:'crm_ask_request_windows_workspace_id_request_id_fkey'});
});
it('keeps financial receipts bound to their request workspace',async()=>{
 const id=randomUUID(),sourceId=randomUUID();
 const reservationId=randomUUID(),jobId=randomUUID();
 await database.session.query(`INSERT INTO provider_reservations(workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens) VALUES($1,$2,'fake-provider','research_run',$3,1,'2026-10-09','Etc/UTC',1,'fake-model',1000,100)`,[seeded.beta.workspaceId,reservationId,randomUUID()]);
 await database.session.query(`INSERT INTO jobs(workspace_id,id,kind,payload,idempotency_key) VALUES($1,$2::uuid,'today.build','{}',$3)`,[seeded.beta.workspaceId,jobId,jobId]);
 const scope={sources:[{workspaceId:seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null}]};
 await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'What was promised?',$4::jsonb,'[]','{"firmIds":[],"personIds":[]}','unavailable','purpose_unavailable')`,[seeded.alpha.workspaceId,id,seeded.alpha.salesperson.userId,JSON.stringify(scope)]);
 await expect(database.session.query(`INSERT INTO crm_ask_financial_receipts(workspace_id,request_id,request_version,request_epoch,stage,attempt,reservation_id,job_id,fencing_token,purpose_revision,config_fingerprint,evaluation_fingerprint,authorization_fingerprint,input_hash,input_price_micros,output_price_micros,max_input_tokens,max_output_tokens,dispatch_state) VALUES($1,$2,1,1,'answer',1,$3,$4,1,1,$5,$5,$5,$5,1,1,1000,100,'reserved')`,[seeded.beta.workspaceId,id,reservationId,jobId,'a'.repeat(64)])).rejects.toMatchObject({code:'23503',constraint:'crm_ask_financial_receipts_workspace_id_request_id_fkey'});
});
