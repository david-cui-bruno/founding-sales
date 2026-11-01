import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {manualOrdinaryFixture} from '../sourcing/support/manualProspectFixture.ts';
let db:TestDatabase,id:string,w:string;
const base={runId:'00000000-0000-4000-8000-000000000001',observationId:'00000000-0000-4000-8000-000000000002',blockId:'b1',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64)};
const labelled={...base,labelStart:0,labelEnd:7,start:9,end:21};
const standalone={...base,labelStart:2,labelEnd:14,start:2,end:14};
const save=(choice:unknown)=>db.session.query('UPDATE sourcing_manual_prospect_states SET manual_phone_choice=$2::jsonb WHERE candidate_id=$1',[id,JSON.stringify(choice)]);
const stored=async()=>(await db.session.query('SELECT state,manual_phone_choice FROM sourcing_manual_prospect_states WHERE candidate_id=$1',[id])).rows;
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:153});const seed=await seedTwoWorkspaces(db.session);w=seed.alpha.workspaceId;
 const ctx=repositoryContext(workspaceScope(w,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),db.session);
 const saved=await saveCandidate(ctx,manualOrdinaryFixture(818));if(!saved.ok)throw Error(saved.reason);id=saved.value.id;
 await db.session.query("INSERT INTO sourcing_manual_prospect_states(workspace_id,candidate_id,candidate_revision,state) VALUES($1,$2,1,'kept')",[w,id]);
 await save(labelled);
});
afterAll(async()=>{await db.drop();});
it('refuses a self-labelled span at 153, then upgrades 153 to 154 without rewriting a stored v1 choice',async()=>{
 await expect(save(standalone)).rejects.toMatchObject({constraint:'manual_prospect_phone_choice_shape'});
 const before=await stored();
 await applyMigrations(db.session,{throughVersion:154});
 expect(await readAppliedSchemaVersion(db.session)).toBe(154);expect(await stored()).toEqual(before);
 const runtime=await db.appRuntimeSession();
 expect((await runtime.query("SELECT has_table_privilege(current_user,'sourcing_manual_prospect_states','SELECT,INSERT,UPDATE,DELETE') allowed")).rows).toEqual([{allowed:true}]);
});
it('stores a standalone self-labelled span and still stores labelled spans and NULL',async()=>{
 await save(standalone);expect((await stored())[0]?.['manual_phone_choice']).toEqual(standalone);
 await save(labelled);expect((await stored())[0]?.['manual_phone_choice']).toEqual(labelled);
 await db.session.query('UPDATE sourcing_manual_prospect_states SET manual_phone_choice=NULL WHERE candidate_id=$1',[id]);
});
it.each([
 {name:'label covers part of the literal',patch:{labelStart:2,labelEnd:8,start:2,end:14}},
 {name:'label starts after the literal',patch:{labelStart:3,labelEnd:14,start:2,end:14}},
 {name:'overlapping label ends after start but not at end',patch:{labelStart:0,labelEnd:10,start:5,end:14}},
 {name:'empty label',patch:{labelStart:2,labelEnd:2,start:2,end:14}},
 {name:'literal over 200',patch:{labelStart:2,labelEnd:203,start:2,end:203}},
 {name:'unknown field',patch:{extra:'original prose'}},
 {name:'malformed hash',patch:{relevantTextHash:'bad'}},
])('keeps rejecting $name',async({patch})=>{
 await expect(save({...standalone,...patch})).rejects.toBeDefined();
});
it('keeps rejecting annotations on non-kept states and non-objects',async()=>{
 await expect(db.session.query("UPDATE sourcing_manual_prospect_states SET state='skipped',manual_phone_choice=$2::jsonb WHERE candidate_id=$1",[id,JSON.stringify(standalone)])).rejects.toBeDefined();
 await expect(db.session.query("UPDATE sourcing_manual_prospect_states SET manual_phone_choice='[]'::jsonb WHERE candidate_id=$1",[id])).rejects.toBeDefined();
});
