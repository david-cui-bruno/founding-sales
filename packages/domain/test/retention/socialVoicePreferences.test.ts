import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveSocialVoicePreferences,readSocialVoicePreferences} from '../../social/voicePreferences.ts';
import {previewDeletion,commitDeletion} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {TABLE_RETENTION_COVERAGE} from '../../retention/coverage.ts';
import {RETENTION_TARGETS} from '../../retention/targets.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const entries=[{entryId:randomUUID(),dimension:'concision' as const,guidance:'Prefer direct neutral clauses.'}];
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const tx=<T>(work:()=>Promise<T>)=>withTransaction(runtime,work);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
it('durable owner guide is classified retained, not scheduled draft expiry or unrelated CRM erasure',async()=>{
 expect(TABLE_RETENTION_COVERAGE['social_voice_preferences']?.dispositions).toEqual(['retained','deletion_removes','departure_revokes']);
 for(const target of RETENTION_TARGETS)expect(target.tables).not.toContain('social_voice_preferences');
 const created=await tx(()=>saveSocialVoicePreferences(ctx(),{operation:'create',entries},async()=>true));expect(created.ok).toBe(true);
 const firmId=randomUUID();await runtime.query("INSERT INTO firms(workspace_id,id,name,assigned_user_id) VALUES($1,$2,'Neutral lifecycle fixture',$3)",[seed.alpha.workspaceId,firmId,seed.alpha.admin.userId]);
 const preview=await tx(()=>previewDeletion(ctx(),{targetKind:'firm',firmId}));if(!preview.ok)throw Error(preview.reason);
 expect(preview.value.removes['social_voice_preferences']).toBeUndefined();expect(preview.value.redacts['social_voice_preferences']).toBeUndefined();
 expect(await tx(()=>commitDeletion(ctx(),{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()}))).toMatchObject({ok:true});
 expect(await tx(()=>readSocialVoicePreferences(ctx(),async()=>true))).toMatchObject({state:'available',revision:1,entries});
});
it('physical owner membership erasure cascades guide current bytes and tombstone through ordinary FK lifecycle',async()=>{
 const userId=randomUUID();await runtime.query('INSERT INTO users(id,google_sub,email,display_name) VALUES($1,$2,$3,$4)',[userId,`voice-${userId}`,'voice-fixture@example.test','Neutral fixture']);
 await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'salesperson')",[seed.alpha.workspaceId,userId]);
 const owner=repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId,role:'salesperson'}),runtime);
 const saved=await tx(()=>saveSocialVoicePreferences(owner,{operation:'create',entries},async()=>true));if(!saved.ok)throw Error(saved.reason);
 await runtime.query('DELETE FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[seed.alpha.workspaceId,userId]);
 expect((await runtime.query('SELECT entries FROM social_voice_preferences WHERE id=$1',[saved.value.guideId])).rows).toEqual([]);
});
it('workspace FK is cascading and cannot orphan guide content outside existing workspace lifecycle authority',async()=>{
 const foreignKeys=(await runtime.query("SELECT confrelid::regclass::text parent,confdeltype FROM pg_constraint WHERE conrelid='social_voice_preferences'::regclass AND contype='f' ORDER BY parent")).rows;
 expect(foreignKeys).toEqual([{parent:'workspace_memberships',confdeltype:'c'},{parent:'workspaces',confdeltype:'c'}]);
 // Workspaces have other independently retained records. This does not claim a new delete-workspace command.
});
