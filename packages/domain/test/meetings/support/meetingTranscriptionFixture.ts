import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../../../db/testing/testDatabase.ts';
import { seedTwoWorkspaces } from '../../db/support/fixtures.ts';
import { repositoryContext, workspaceScope } from '../../../db/workspaceScope.ts';
import { registerMeetingRecordings } from '../../../meetings/recordings.ts';
import { withTransaction } from '../../../db/queryable.ts';
export async function meetingTranscriptionFixture() {
    const db = await createTestDatabase();
    const seeded = await seedTwoWorkspaces(db.session);
    const workspace = seeded.alpha.workspaceId;
    const context = repositoryContext(workspaceScope(workspace, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), db.session);
    const firmId = (await db.session.query<{
        id: string;
    }>('INSERT INTO firms (workspace_id,name,assigned_user_id) VALUES ($1,$2,$3) RETURNING id', [workspace, 'Transcript Fixture Rentals', seeded.alpha.salesperson.userId])).rows[0]?.id ?? '';
    const meeting = async () => {
        const id = randomUUID();
        await db.session.query(`INSERT INTO meetings (workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at)
      VALUES ($1,$2,$3,$3,$4,'booked',now(),now()+interval '20 minutes',now())`, [workspace, id, randomUUID().replaceAll('-', ''), firmId]);
        return id;
    };
    const recording = async (meetingId: string, digest = 'a'.repeat(64)) => {
        const result = await withTransaction(db.session, async () => await registerMeetingRecordings(context, { meetingId,
            files: [{ sha256: digest, sizeBytes: 100, segment: 1, participantLabel: 'Participant fixture' }] }, async () => await Promise.resolve({ verdict: 'ok' as const, uploadId: null })));
        if (!result.ok)
            throw new Error(result.reason);
        return result.value.files[0]?.recordingId ?? '';
    };
    const transcript = async (recordingId: string, count = 1) => {
        const utterances = Array.from({ length: count }, (_, i) => ({ startMs: i * 100, endMs: i * 100 + 90, text: `Statement ${String(i)}`, speaker: null, attribution: 'source_label' }));
        return (await db.session.query<{
            id: string;
        }>(`INSERT INTO meeting_transcripts (workspace_id,recording_id,original_recording_id,version,duration_ms,language,utterances)
      VALUES ($1,$2,$2,1,$3,'en-US',$4::jsonb) RETURNING id`, [workspace, recordingId, Math.max(100, count * 100), JSON.stringify(utterances)])).rows[0]?.id ?? '';
    };
    return { db, seeded, workspace, context, firmId, meeting, recording, transcript };
}
