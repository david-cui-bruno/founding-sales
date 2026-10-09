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
