import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
let database:TestDatabase,workspaceId:string,mailboxId:string,ownerId:string,importId:string,recoveryId:string;
beforeAll(async()=>{database=await createTestDatabase();const fixture=await seedTwoWorkspaces(database.session);workspaceId=fixture.alpha.workspaceId;ownerId=fixture.alpha.salesperson.userId;mailboxId=(await database.session.query<{id:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,sync_state,baseline_from_at,baseline_completed_at) VALUES($1,$2,'backfill@alpha.example.test','catalog-account','ready',now()-interval '7 days',now()) RETURNING id",[workspaceId,ownerId])).rows[0]!.id;});
afterAll(async()=>{await database.drop();});
beforeEach(async()=>{
 await database.session.query('BEGIN');
 importId=(await database.session.query<{id:string}>("INSERT INTO crm_mail_imports(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,controls_revision,policy_revision,from_at,to_at) VALUES($1,$2,$3,'catalog-account',repeat('a',64),1,1,1,now()-interval '90 days',now()) RETURNING id",[workspaceId,mailboxId,ownerId])).rows[0]!.id;
 recoveryId=(await database.session.query<{id:string}>("INSERT INTO crm_mail_history_recoveries(workspace_id,import_id,epoch,account_binding,generation,controls_revision,policy_revision,allocation_revision,configuration_hash,from_at) VALUES($1,$2,1,repeat('a',64),1,1,1,1,repeat('b',64),now()-interval '1 day') RETURNING id",[workspaceId,importId])).rows[0]!.id;
});
afterEach(async()=>{await database.session.query('ROLLBACK');});
const update=(assignment:string)=>database.session.query(`UPDATE crm_mail_history_recoveries SET ${assignment},revision=revision+1,observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,[workspaceId,recoveryId]);
const frozen="to_at=from_at+interval '1 day',history_anchor='100',history_cursor='100',total_days=1";
it('rejects completion directly from pending profile despite a well-shaped completed tuple',async()=>{await expect(update(`${frozen},next_day_ordinal=1,state='complete',completed_at=clock_timestamp()`)).rejects.toMatchObject({constraint:'crm_mail_recovery_monotonic'});});
it('rejects freezing with fabricated slice or history progress',async()=>{await expect(update(`${frozen},next_day_ordinal=1,state='enumerating'`)).rejects.toMatchObject({constraint:'crm_mail_recovery_monotonic'});});
it('rejects a fabricated history continuation token at first profile freeze',async()=>{await expect(update(`${frozen},history_page_token='not-read',state='enumerating'`)).rejects.toMatchObject({constraint:'crm_mail_recovery_monotonic'});});
it('rejects skipping the history drain after gap enumeration',async()=>{await update(`${frozen},state='enumerating'`);await expect(update("next_day_ordinal=1,state='complete',completed_at=clock_timestamp()")).rejects.toMatchObject({constraint:'crm_mail_recovery_monotonic'});});
it('rejects restarting enumeration from the pending profile phase',async()=>{await update(`${frozen},state='enumerating'`);await expect(update("state='pending_profile',to_at=NULL,history_anchor=NULL,history_cursor=NULL,total_days=NULL")).rejects.toMatchObject({constraint:'crm_mail_recovery_monotonic'});});
it('permits actual freeze, enumeration, history drain and terminal deletion in order',async()=>{
 await update(`${frozen},state='enumerating'`);await update("next_day_ordinal=1,state='draining',reconciliation_exhausted=true");await update("history_cursor='200',state='complete',completed_at=clock_timestamp()");
 await update("state='deleted',reason='metadata_deleted',reconciliation_exhausted=false,from_at=NULL,to_at=NULL,history_anchor=NULL,history_cursor=NULL,total_days=NULL,next_day_ordinal=0,completed_at=NULL");
 expect((await database.session.query('SELECT state,revision FROM crm_mail_history_recoveries WHERE workspace_id=$1 AND id=$2',[workspaceId,recoveryId])).rows).toEqual([{state:'deleted',revision:5}]);
});
it('requires the epoch traversal to exhaust before claiming completed gap coverage',async()=>{await update(`${frozen},state='enumerating'`);await update("next_day_ordinal=1,state='draining'");await expect(update("state='complete',completed_at=clock_timestamp()")).rejects.toMatchObject({constraint:'crm_mail_recovery_reconciliation_phase'});});
it('cannot reset measured epoch traversal counters',async()=>{await update(`${frozen},state='enumerating'`);await update("reconciliation_visited=1,reconciliation_refreshed=1");await expect(update("reconciliation_visited=0,reconciliation_refreshed=0")).rejects.toMatchObject({constraint:'crm_mail_recovery_monotonic'});});
it('rejects immutable binding drift before any SDK work can gain authority',async()=>{await expect(update("configuration_hash=repeat('c',64)")).rejects.toMatchObject({constraint:'crm_mail_recovery_immutable'});});
it('keeps ledger privileges restricted and required bounded scan indexes in the disposable catalog',async()=>{
 const row=(await database.session.query<{table_update:boolean;state_update:boolean;time_update:boolean;units_update:boolean;can_delete:boolean}>("SELECT has_table_privilege('app_runtime','crm_mail_import_read_reservations','UPDATE') AS table_update,has_column_privilege('app_runtime','crm_mail_import_read_reservations','state','UPDATE') AS state_update,has_column_privilege('app_runtime','crm_mail_import_read_reservations','observed_at','UPDATE') AS time_update,has_column_privilege('app_runtime','crm_mail_import_read_reservations','units','UPDATE') AS units_update,has_table_privilege('app_runtime','crm_mail_import_read_reservations','DELETE') AS can_delete")).rows[0];
 expect(row).toEqual({table_update:false,state_update:true,time_update:true,units_update:false,can_delete:false});
 const names=(await database.session.query<{indexname:string}>("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname IN ('crm_mail_import_active_jobs','crm_mail_history_recovery_unfinished','crm_mail_import_read_project_window','crm_mail_import_read_user_window','crm_mail_import_pending_scan') ORDER BY indexname")).rows.map(row=>row.indexname);
 expect(names).toEqual(['crm_mail_history_recovery_unfinished','crm_mail_import_active_jobs','crm_mail_import_pending_scan','crm_mail_import_read_project_window','crm_mail_import_read_user_window']);
});
