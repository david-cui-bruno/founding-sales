import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from './support/fixtures.ts';
import {socialVoiceEntriesSchema} from '@fss/contracts';
let db:TestDatabase,seed:TwoWorkspaces;
const entry=()=>({entryId:randomUUID(),dimension:'tone',guidance:'Use direct neutral language.'});
beforeAll(async()=>{db=await createTestDatabase({throughVersion:135});seed=await seedTwoWorkspaces(db.session);expect(await readAppliedSchemaVersion(db.session)).toBe(135);await applyMigrations(db.session,{throughVersion:136});expect(await readAppliedSchemaVersion(db.session)).toBe(136);});
afterAll(async()=>db?.drop());
const invalid=[null,{},[],Array.from({length:21},entry),[{...entry(),extra:'forbidden'}],[{...entry(),guidance:' \t\n'}],[{...entry(),guidance:'\u00a0\ufeff'}],[{...entry(),guidance:'x'.repeat(501)}],[{...entry(),guidance:'😀'.repeat(251)}],[{...entry(),dimension:'fact'}],[{...entry(),entryId:'invalid'}],[{...entry(),guidance:null}],[{...entry(),guidance:123}],[null],Array.from({length:20},()=>({...entry(),guidance:'x'.repeat(500)}))];
it.each(invalid.map((entries,index)=>({entries,index})))('upgrade rejects malformed or over-limit entries case $index',async({entries})=>{
 const runtime=await db.appRuntimeSession();await runtime.query('BEGIN');try{await expect(runtime.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,entries) VALUES($1,$2,$3::jsonb)',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(entries)])).rejects.toMatchObject({constraint:'social_voice_content'});}finally{await runtime.query('ROLLBACK');}
});
it('rejects duplicate UUIDs and mismatched terminal shape, nonpositive revisions and duplicate owner rows',async()=>{
 const runtime=await db.appRuntimeSession(),entries=[entry()];
 for(const [sql,values,constraint] of [
  ['INSERT INTO social_voice_preferences(workspace_id,owner_user_id,entries) VALUES($1,$2,$3::jsonb)',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify([entries[0],entries[0]])],'social_voice_content'],
  ['INSERT INTO social_voice_preferences(workspace_id,owner_user_id,entries,removed_at) VALUES($1,$2,$3::jsonb,now())',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(entries)],'social_voice_content'],
  ['INSERT INTO social_voice_preferences(workspace_id,owner_user_id,revision,entries) VALUES($1,$2,0,$3::jsonb)',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(entries)],'social_voice_preferences_revision_check'],
 ] as const){await runtime.query('BEGIN');try{await expect(runtime.query(sql,values)).rejects.toMatchObject({constraint});}finally{await runtime.query('ROLLBACK');}}
 await runtime.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,entries) VALUES($1,$2,$3::jsonb)',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(entries)]);
 await expect(runtime.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,entries) VALUES($1,$2,$3::jsonb)',[seed.alpha.workspaceId,seed.alpha.admin.userId,JSON.stringify(entries)])).rejects.toMatchObject({code:'23505'});
});
it('rejects foreign workspace/owner and duplicate stable guide identity constraints with actual inserts',async()=>{
 const runtime=await db.appRuntimeSession(),entries=[entry()],id=randomUUID();
 const cases=[
  {workspace:randomUUID(),owner:seed.alpha.admin.userId,id:randomUUID(),constraint:'social_voice_preferences_workspace_id_fkey'},
  {workspace:seed.alpha.workspaceId,owner:randomUUID(),id:randomUUID(),constraint:'social_voice_preferences_workspace_id_owner_user_id_fkey'},
 ];
 for(const test of cases){await runtime.query('BEGIN');try{await expect(runtime.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,id,entries) VALUES($1,$2,$3,$4::jsonb)',[test.workspace,test.owner,test.id,JSON.stringify(entries)])).rejects.toMatchObject({constraint:test.constraint});}finally{await runtime.query('ROLLBACK');}}
 await runtime.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,id,entries) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,seed.alpha.salesperson.userId,id,JSON.stringify(entries)]);
 await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'salesperson')",[seed.alpha.workspaceId,seed.beta.salesperson.userId]);
 await expect(runtime.query('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,id,entries) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,seed.beta.salesperson.userId,id,JSON.stringify(entries)])).rejects.toMatchObject({constraint:'social_voice_preferences_workspace_id_id_key'});
});
it('database byte boundary matches normalized contract JSON rather than jsonb pretty spacing',async()=>{
 const entries=Array.from({length:18},()=>({...entry(),guidance:'x'.repeat(450)}));
 const extra=10000-Buffer.byteLength(JSON.stringify(entries));entries[0]!.guidance+='x'.repeat(Math.min(extra,50));
 expect(socialVoiceEntriesSchema.safeParse(entries).success).toBe(true);
 expect((await db.session.query('SELECT valid_social_voice_entries($1::jsonb) valid',[JSON.stringify(entries)])).rows[0]?.['valid']).toBe(true);
});
it('classifies all actual guide constraints and no source/account/provider foreign keys',async()=>{
 const names=(await db.session.query("SELECT conname FROM pg_constraint WHERE conrelid='social_voice_preferences'::regclass ORDER BY conname")).rows.map(row=>row['conname']);
 expect(names).toEqual(['social_voice_content','social_voice_preferences_pkey','social_voice_preferences_revision_check','social_voice_preferences_workspace_id_fkey','social_voice_preferences_workspace_id_id_key','social_voice_preferences_workspace_id_owner_user_id_fkey']);
});
