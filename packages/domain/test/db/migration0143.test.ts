import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {manualOrdinaryFixture} from '../sourcing/support/manualProspectFixture.ts';
let db:TestDatabase,id:string,w:string;
const choice={runId:'00000000-0000-4000-8000-000000000001',observationId:'00000000-0000-4000-8000-000000000002',blockId:'b1',labelStart:0,labelEnd:7,start:9,end:21,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64)};
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:142});const seed=await seedTwoWorkspaces(db.session);w=seed.alpha.workspaceId;
 const ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
 const saved=await saveCandidate(ctx,manualOrdinaryFixture(818));if(!saved.ok)throw Error(saved.reason);id=saved.value.id;
 // Schema142 writes the legacy row directly; current source requires143.
 await db.session.query("INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state) VALUES($1,$2,1,'kept')",[w,id]);
 await applyMigrations(db.session,{throughVersion:143});expect(await readAppliedSchemaVersion(db.session)).toBe(143);
});
afterAll(async()=>{await db.drop();});
it('preserves142 rows and existing runtime privileges through143',async()=>{
 expect((await db.session.query('SELECT state,manual_phone_choice FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[id])).rows).toEqual([{state:'kept',manual_phone_choice:null}]);
 const runtime=await db.appRuntimeSession();expect((await runtime.query("SELECT has_table_privilege(current_user,'sourcing_manual_prospect_states','SELECT,INSERT,UPDATE,DELETE') allowed")).rows).toEqual([{allowed:true}]);
 await runtime.query('UPDATE sourcing_manual_prospect_states SET manual_phone_choice=$2::jsonb WHERE candidate_id=$1',[id,JSON.stringify(choice)]);
 await runtime.query('UPDATE sourcing_manual_prospect_states SET manual_phone_choice=NULL WHERE candidate_id=$1',[id]);
});
it.each([{value:'9402620091'},{start:9.1},{end:9},{labelEnd:0},{blockId:''},{contentHash:null},{relevantTextHash:'bad'},{runId:'bad'},{extra:'original prose'}])('rejects malformed or prose metadata %j',async patch=>{
 await expect(db.session.query('UPDATE sourcing_manual_prospect_states SET manual_phone_choice=$2::jsonb WHERE candidate_id=$1',[id,JSON.stringify({...choice,...patch})])).rejects.toBeDefined();
});
it('rejects annotations on skipped states and nonobjects',async()=>{
 await expect(db.session.query("UPDATE sourcing_manual_prospect_states SET state='skipped',manual_phone_choice=$2::jsonb WHERE candidate_id=$1",[id,JSON.stringify(choice)])).rejects.toBeDefined();
 await expect(db.session.query("UPDATE sourcing_manual_prospect_states SET manual_phone_choice='[]'::jsonb WHERE candidate_id=$1",[id])).rejects.toBeDefined();
});
