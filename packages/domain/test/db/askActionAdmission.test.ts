import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import type {SessionQueryable} from '../../db/queryable.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {seedAskRequest} from './support/askAnswerCases.ts';
let database:TestDatabase;let runtime:SessionQueryable;let seeded:TwoWorkspaces;
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);runtime=await database.appRuntimeSession();});
afterAll(async()=>{await database.drop();});
it('refuses copying an investigation into a manual action owned by a different active workspace member',async()=>{
 const requestId=await seedAskRequest({session:runtime,seeded});
 const parent=(await runtime.query<{scope:{sources:Record<string,unknown>[]};initial_contexts:unknown;initial_access_closure:unknown}>('SELECT scope,initial_contexts,initial_access_closure FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,requestId])).rows[0]!;
 const refs=[{...parent.scope.sources[0],locator:'text:0:4'}];
 await expect(runtime.query(`INSERT INTO crm_ask_actions(workspace_id,owner_user_id,source_request_id,source_request_version,kind,status,human_text,input_scope,initial_contexts,original_access_closure,support_refs) VALUES($1,$2,$3,1,'preference','proposed','Prefer explicit maintenance evidence',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb)`,[seeded.alpha.workspaceId,seeded.alpha.admin.userId,requestId,JSON.stringify(parent.scope),JSON.stringify(parent.initial_contexts),JSON.stringify(parent.initial_access_closure),JSON.stringify(refs)])).rejects.toMatchObject({code:'23514',constraint:'crm_ask_action_current_request'});
 expect((await runtime.query<{count:string}>('SELECT count(*) AS count FROM crm_ask_actions WHERE workspace_id=$1 AND source_request_id=$2',[seeded.alpha.workspaceId,requestId])).rows[0]!.count).toBe('0');
});
