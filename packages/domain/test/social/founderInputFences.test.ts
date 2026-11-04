import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const missing='00000000-0000-4000-8000-000000000163';
const fenceError={code:'P0001',message:'social_founder_input_terminal_or_invalid_revision'};
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db.drop());
it.each([
 ['same revision','revision=revision'],
 ['skipped revision','revision=revision+2'],
 ['first-save time',"created_at=created_at-interval '1 day',revision=revision+1"],
 ['source deadline',"expires_at=expires_at-interval '1 day',revision=revision+1"],
 ['input identity','id=gen_random_uuid(),revision=revision+1'],
 ['owner identity',`owner_user_id='${missing}',revision=revision+1`],
 ['workspace identity',`workspace_id='${missing}',revision=revision+1`],
] as const)('ordinary source fence refuses direct mutation of %s before storage constraints',async(_name,assignment)=>{
 const id=randomUUID();
 await expect(withTransaction(runtime,async()=>{
  await runtime.query("INSERT INTO social_founder_inputs(workspace_id,owner_user_id,id,bullets,context,public_safe) VALUES($1,$2,$3,'Controlled current input.','Actual owner opinion.',true)",[seed.alpha.workspaceId,seed.alpha.admin.userId,id]);
  await runtime.query(`UPDATE social_founder_inputs SET ${assignment} WHERE workspace_id=$1 AND id=$2`,[seed.alpha.workspaceId,id]);
 })).rejects.toMatchObject(fenceError);
 expect((await runtime.query('SELECT id FROM social_founder_inputs WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,id])).rows).toEqual([]);
});
it.each(['removed','expired','owner_unavailable'])('ordinary terminal %s fence refuses direct prose resurrection',async reason=>{
 const id=randomUUID();
 await expect(withTransaction(runtime,async()=>{
  await runtime.query('INSERT INTO social_founder_inputs(workspace_id,owner_user_id,id,bullets,context,public_safe,reason) VALUES($1,$2,$3,NULL,NULL,false,$4)',[seed.alpha.workspaceId,seed.alpha.admin.userId,id,reason]);
  await runtime.query("UPDATE social_founder_inputs SET reason=NULL,bullets='Forbidden resurrection.',context='',public_safe=true,revision=revision+1 WHERE workspace_id=$1 AND id=$2",[seed.alpha.workspaceId,id]);
 })).rejects.toMatchObject(fenceError);
});
