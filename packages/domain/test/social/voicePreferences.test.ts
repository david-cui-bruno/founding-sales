import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {saveSocialVoicePreferences,readSocialVoicePreferences} from '../../social/voicePreferences.ts';
import {PrivateDraftAuthorityChanged} from '../../social/privateDrafts.ts';
import {sweepPrivateDrafts} from '../../retention/socialDrafts.ts';
import type {SocialVoiceSaveInput} from '@fss/contracts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const authority=async()=>true;
const ctx=(session=runtime,user=seed.alpha.admin,workspace=seed.alpha.workspaceId)=>repositoryContext(workspaceScope(workspace,{kind:'user',userId:user.userId,role:user===seed.alpha.admin?'admin':'salesperson'}),session);
const entries=()=>[{entryId:randomUUID(),dimension:'tone' as const,guidance:'Prefer short neutral sentences.'}];
const save=(input:SocialVoiceSaveInput,session=runtime)=>withTransaction(session,()=>saveSocialVoicePreferences(ctx(session),input,authority));
async function create(){const result=await save({operation:'create',entries:entries()});if(!result.ok)throw Error(result.reason);return result.value;}
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await runtime.query('DELETE FROM social_voice_preferences');});
afterAll(async()=>db?.drop());
it('app_runtime durable empty/create/read/update/remove/restart is one stable guide with monotonic revisions',async()=>{
 expect((await runtime.query('SELECT current_user')).rows[0]?.['current_user']).toBe('app_runtime');expect(await withTransaction(runtime,()=>readSocialVoicePreferences(ctx(),authority))).toEqual({state:'absent'});
 const first=await create();const initial=await withTransaction(runtime,()=>readSocialVoicePreferences(ctx(),authority));expect(initial).toMatchObject({state:'available',guideId:first.guideId,revision:1});
 const updated=entries();expect(await save({operation:'update',guideId:first.guideId,expectedRevision:1,entries:updated})).toEqual({ok:true,value:{guideId:first.guideId,revision:2}});
 expect(await save({operation:'restart',guideId:first.guideId,expectedRevision:2,entries:entries()})).toEqual({ok:false,reason:'not_removed'});
 expect(await save({operation:'remove',guideId:first.guideId,expectedRevision:2})).toEqual({ok:true,value:{guideId:first.guideId,revision:3}});
 expect((await runtime.query('SELECT entries,revision,removed_at IS NOT NULL removed FROM social_voice_preferences')).rows[0]).toEqual({entries:null,revision:3,removed:true});
 const removed=await withTransaction(runtime,()=>readSocialVoicePreferences(ctx(),authority));expect(removed).toMatchObject({state:'removed',revision:3});expect(removed).not.toHaveProperty('entries');
 for(const operation of ['update','remove','restart'] as const){const input=operation==='remove'?{operation,guideId:first.guideId,expectedRevision:2}:{operation,guideId:first.guideId,expectedRevision:2,entries:updated};expect(await save(input)).toEqual({ok:false,reason:'stale_revision'});}
 expect(await save({operation:'create',entries:updated})).toEqual({ok:false,reason:'already_exists'});
 expect(await save({operation:'update',guideId:first.guideId,expectedRevision:3,entries:updated})).toEqual({ok:false,reason:'removed'});
 expect(await save({operation:'restart',guideId:first.guideId,expectedRevision:3,entries:entries()})).toEqual({ok:true,value:{guideId:first.guideId,revision:4}});
 expect((await runtime.query('SELECT count(*)::int n FROM social_voice_preferences')).rows[0]?.['n']).toBe(1);
});
it('scopes every read/write to exact owner and workspace and rejects extra fields',async()=>{
 const first=await create();expect(await withTransaction(runtime,()=>readSocialVoicePreferences(ctx(runtime,seed.alpha.salesperson),authority))).toEqual({state:'absent'});
 expect(await withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(runtime,seed.alpha.salesperson),{operation:'remove',guideId:first.guideId,expectedRevision:1},authority))).toEqual({ok:false,reason:'not_found'});
 expect(await withTransaction(runtime,()=>readSocialVoicePreferences(ctx(runtime,seed.alpha.admin,seed.beta.workspaceId),authority))).toBeNull();
 expect(await save({operation:'create',entries:entries(),draftId:randomUUID()} as never)).toEqual({ok:false,reason:'invalid_input'});
});
it('concurrent first creates and concurrent same-revision updates serialize absence and refuse stale replacement',async()=>{
 const a=await db.appRuntimeSession(),b=await db.appRuntimeSession();const results=await Promise.all([save({operation:'create',entries:entries()},a),save({operation:'create',entries:entries()},b)]);expect(results.filter(result=>result.ok)).toHaveLength(1);expect(results.filter(result=>!result.ok)).toEqual([{ok:false,reason:'already_exists'}]);
 const first=results.find(result=>result.ok);if(!first?.ok)throw Error('Missing winner');const input={operation:'update' as const,guideId:first.value.guideId,expectedRevision:1,entries:entries()};const updates=await Promise.all([save(input,a),save(input,b)]);expect(updates.filter(result=>result.ok)).toHaveLength(1);expect(updates.filter(result=>!result.ok)).toEqual([{ok:false,reason:'stale_revision'}]);
});
it('transient authority and role loss do not erase legitimate content, departure physically erases and restoration cannot revive',async()=>{
 const first=await create();await expect(withTransaction(runtime,()=>readSocialVoicePreferences(ctx(),async()=>false))).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 await runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active')",[seed.alpha.workspaceId,seed.beta.admin.userId]);
 try{
  await runtime.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);expect((await runtime.query('SELECT entries FROM social_voice_preferences')).rows[0]?.['entries']).not.toBeNull();
  await runtime.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);expect((await runtime.query('SELECT entries,revision FROM social_voice_preferences')).rows[0]).toEqual({entries:null,revision:2});
 }finally{await runtime.query("UPDATE workspace_memberships SET role='admin',status='active',deactivated_at=NULL WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);}
 expect(await save({operation:'update',guideId:first.guideId,expectedRevision:1,entries:entries()})).toEqual({ok:false,reason:'stale_revision'});
});
it('current authority is checked after real guide lock wait and final failure rolls back without erasure',async()=>{
 const first=await create(),writer=await db.appRuntimeSession(),reader=await db.appRuntimeSession();await writer.query('BEGIN');await writer.query('SELECT id FROM social_voice_preferences WHERE id=$1 FOR UPDATE',[first.guideId]);const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 let allowed=true;const reading=withTransaction(reader,()=>readSocialVoicePreferences(ctx(reader),async()=>allowed));const rejection=expect(reading).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 try{await expect.poll(async()=>Boolean((await runtime.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);allowed=false;}finally{await writer.query('COMMIT');}await rejection;
 let checks=0;await expect(withTransaction(runtime,()=>saveSocialVoicePreferences(ctx(),{operation:'update',guideId:first.guideId,expectedRevision:1,entries:entries()},async()=>++checks<2))).rejects.toBeInstanceOf(PrivateDraftAuthorityChanged);
 expect((await runtime.query('SELECT revision,entries IS NOT NULL present FROM social_voice_preferences')).rows[0]).toEqual({revision:1,present:true});
});
it('durable guide survives draft expiry and unrelated source deletion and never mutates side-effect ledgers',async()=>{
 const first=await create();await runtime.query("UPDATE social_voice_preferences SET created_at=now()-interval '120 days',updated_at=now()-interval '120 days' WHERE id=$1",[first.guideId]);expect(await withTransaction(runtime,()=>sweepPrivateDrafts(ctx(),500))).toBe(0);
 const id=randomUUID();await runtime.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,$3,$4::jsonb)',[seed.alpha.workspaceId,id,id.replaceAll('-','').repeat(2),JSON.stringify({brief:'Neutral source fixture.'})]);await runtime.query('DELETE FROM sourcing_candidates WHERE id=$1',[id]);
 expect(await withTransaction(runtime,()=>readSocialVoicePreferences(ctx(),authority))).toMatchObject({state:'available',revision:1});
 for(const table of ['social_posts','social_post_revisions','social_accounts','social_draft_requests','social_private_drafts','jobs','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 const audit=(await runtime.query("SELECT detail FROM audit_events WHERE action='social.voice_preferences_saved'")).rows;expect(JSON.stringify(audit)).not.toContain('Prefer short');
});
