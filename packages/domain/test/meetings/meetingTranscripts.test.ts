import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
describe('durable meeting transcript storage', () => {
    let db: TestDatabase;
    let seeded: TwoWorkspaces;
    beforeAll(async () => { db = await createTestDatabase(); seeded = await seedTwoWorkspaces(db.session); });
    afterAll(async () => { await db.drop(); });
    it('stores bounded transcripts tied to their workspace and deletes speech with the meeting', async () => {
        const tables = await db.session.query<{
            name: string;
        }>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public'");
        expect(tables.rows.map(row => row.name)).toContain('meeting_transcripts');
        const workspace = seeded.alpha.workspaceId;
        const meetingId = randomUUID();
        const recordingId = randomUUID();
        await db.session.query(`INSERT INTO meetings (workspace_id,id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at)
      VALUES ($1,$2,'m5store','m5store','booked',now(),now()+interval '20 minutes',now())`, [workspace, meetingId]);
        await db.session.query(`INSERT INTO meeting_recordings (workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key)
      VALUES ($1,$2,$3,1,'Participant A',$4,100,$5)`, [workspace, recordingId, meetingId, 'a'.repeat(64), `meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
        const insert = (scope: string, duration = 1000) => db.session.query(`INSERT INTO meeting_transcripts
      (workspace_id,recording_id,original_recording_id,version,duration_ms,language,utterances)
      VALUES ($1,$2,$2,1,$3,'en-US','[]')`, [scope, recordingId, duration]);
        await expect(insert(seeded.beta.workspaceId)).rejects.toMatchObject({ code: '23503' });
        await expect(insert(workspace, 14400001)).rejects.toMatchObject({ code: '23514' });
        await insert(workspace);
        await expect(insert(workspace)).rejects.toMatchObject({ code: '23505' });
        await db.session.query('DELETE FROM meetings WHERE workspace_id=$1 AND id=$2', [workspace, meetingId]);
        expect((await db.session.query('SELECT id FROM meeting_transcripts WHERE workspace_id=$1', [workspace])).rows).toEqual([]);
    });
});
