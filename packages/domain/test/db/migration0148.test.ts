import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {saveSocialPrivateDraft} from '../../social/privateDrafts.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
let db:Awaited<ReturnType<typeof createTestDatabase>>,before:unknown[],settings:unknown[];
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:147});const seed=await seedTwoWorkspaces(db.session),runtime=await db.appRuntimeSession();
 const ctx=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
 expect(await withTransaction(runtime,()=>saveSocialPrivateDraft(ctx,{operation:'create',kind:'comment',text:'Fictional retained private composition must survive the public-reader migration.',origin:{kind:'manual'}},async()=>true))).toMatchObject({ok:true});
 before=(await runtime.query('SELECT * FROM social_private_drafts ORDER BY workspace_id,id')).rows;
 settings=(await runtime.query('SELECT * FROM workspace_settings ORDER BY workspace_id,setting_key,version')).rows;
 await applyMigrations(db.session,{throughVersion:148});
});
afterAll(async()=>db?.drop());
it('populated147 upgrade preserves private originals/settings and creates no public snapshots or activation',async()=>{
 expect(await readAppliedSchemaVersion(db.session)).toBe(148);
 expect((await db.session.query('SELECT * FROM social_private_drafts ORDER BY workspace_id,id')).rows).toEqual(before);
 expect((await db.session.query('SELECT * FROM workspace_settings ORDER BY workspace_id,setting_key,version')).rows).toEqual(settings);
 expect((await db.session.query('SELECT * FROM social_public_threads')).rows).toEqual([]);
});
it('keeps ordinary source-barrier deletion unavailable while allowing migration/workspace cleanup',async()=>{
 expect((await db.session.query("SELECT has_table_privilege('app_runtime','social_public_threads','SELECT') AS read,has_table_privilege('app_runtime','social_public_threads','INSERT') AS retain,has_table_privilege('app_runtime','social_public_threads','UPDATE') AS erase,has_table_privilege('app_runtime','social_public_threads','DELETE') AS delete,has_table_privilege('migration','social_public_threads','DELETE') AS migration_delete")).rows[0])
  .toEqual({read:true,retain:true,erase:true,delete:false,migration_delete:true});
});
