import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
let database:TestDatabase;let seeded:TwoWorkspaces;
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);});
afterAll(async()=>{await database.drop();});
it('keeps human-confirmed manual action text immutable independently of the saved investigation',async()=>{
 const requestId=randomUUID(),actionId=randomUUID(),sourceId=randomUUID();
 const source={workspaceId:seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null};
 const scope=JSON.stringify({sources:[source]});
 const contexts='[{"personId":null,"firmIds":[],"relationships":[],"review":"current"}]';
 const closure='{"firmIds":[],"personIds":[]}';
 await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'What needs review?',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')`,[seeded.alpha.workspaceId,requestId,seeded.alpha.salesperson.userId,scope,contexts,closure]);
 await database.session.query(`INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,human_text,input_scope,initial_contexts,original_access_closure,support_refs) VALUES($1,$2,$3,$4,1,'preference','proposed','Prefer explicit human review.',$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb)`,[seeded.alpha.workspaceId,actionId,seeded.alpha.salesperson.userId,requestId,scope,contexts,closure,JSON.stringify([{...source,locator:'text:0:4'}])]);
 await expect(database.session.query('UPDATE crm_ask_actions SET human_text=$3 WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,actionId,'Silently replaced policy.'])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_action_immutable'});
});
it('refuses copied private text inside a manual action canonical support receipt',async()=>{
 const requestId=randomUUID(),sourceId=randomUUID();
 const source={workspaceId:seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:null};
 const scope=JSON.stringify({sources:[source]});
 const contexts='[{"personId":null,"firmIds":[],"relationships":[],"review":"current"}]';
 const closure='{"firmIds":[],"personIds":[]}';
 await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'What needs review?',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')`,[seeded.alpha.workspaceId,requestId,seeded.alpha.salesperson.userId,scope,contexts,closure]);
 await expect(database.session.query(`INSERT INTO crm_ask_actions(workspace_id,owner_user_id,source_request_id,source_request_version,kind,status,human_text,input_scope,initial_contexts,original_access_closure,support_refs) VALUES($1,$2,$3,1,'preference','proposed','Prefer explicit human review.',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)`,[seeded.alpha.workspaceId,seeded.alpha.salesperson.userId,requestId,scope,contexts,closure,JSON.stringify([{...source,locator:'text:0:4',question:'Private provider question'}])])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_action_support'});
});
