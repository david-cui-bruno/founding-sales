import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {loadMigrations} from '../../db/migrationRunner.ts';
import {classifyMigration} from '../../../../tools/upgrade/classify.ts';
const file=fileURLToPath(new URL('../../db/migrations/0141_social_voice_generation_lifecycle.sql',import.meta.url));
const migration=loadMigrations().find(item=>item.version===141)!;
it('loads contiguous migration0141 with an exact first-line affected-object declaration',()=>{
 expect(migration.fileName).toBe('0141_social_voice_generation_lifecycle.sql');
 expect(migration.sql.split('\n')[0]).toBe('-- changes: social_draft_requests, social_private_drafts, social_voice_preferences, workspace_memberships');
});
it('existing real migration classifier recognizes both existing lifecycle trigger owners',()=>{
 const result=classifyMigration(file);expect(result.kind).toBe('touches-existing');expect(result.hasUnclassified).toBe(false);expect(result.appliedOn).toBe(140);
 expect(result.decisions.filter(decision=>decision.kind==='touches-existing').map(decision=>decision.why)).toEqual(expect.arrayContaining([expect.stringContaining('social_voice_preferences'),expect.stringContaining('workspace_memberships')]));
});
it('only updates exact owner/workspace/guide-derived current outputs and clears terminal private snapshots',()=>{
 expect(migration.sql.match(/UPDATE social_draft_requests/gu)).toHaveLength(1);expect(migration.sql.match(/UPDATE social_private_drafts/gu)).toHaveLength(1);
 expect(migration.sql.match(/workspace_id=p_workspace AND owner_user_id=p_owner/gu)).toHaveLength(2);
 expect(migration.sql.match(/source_selection->'voiceGuideRef'->>'guideId'=p_guide::text/gu)).toHaveLength(2);
 expect(migration.sql).toContain("text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL");expect(migration.sql).toContain("dependencies='{}',reason='source_changed_or_unavailable'");
});
it('adds no provider/history/guide content writes and leaves uncertainty with existing reservation owners',()=>{
 expect(migration.sql).not.toMatch(/\b(?:INSERT|DELETE FROM|TRUNCATE|DROP|GRANT|CREATE TABLE)\b/iu);
 expect(migration.sql).not.toMatch(/UPDATE\s+(?:provider_reservations|social_voice_preferences|command_receipts|social_posts|social_post_revisions|jobs)\b/iu);
 expect(migration.sql).not.toContain('paid_attempts=');expect(migration.sql).not.toContain("state='queued'");
});
it('covers guide revision/content/removal/identity changes, deletion, and owner status/role changes',()=>{
 for(const field of ['revision','entries','removed_at','workspace_id','owner_user_id','id'])expect(migration.sql).toContain(`NEW.${field} IS DISTINCT FROM OLD.${field}`);
 expect(migration.sql).toContain("IF TG_OP='DELETE' THEN");expect(migration.sql).toContain("NEW.status IS DISTINCT FROM 'active' OR NEW.role IS DISTINCT FROM OLD.role");
 expect(migration.sql).toContain('ORDER BY id FOR UPDATE LOOP');
});
