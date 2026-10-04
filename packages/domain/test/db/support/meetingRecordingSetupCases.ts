import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../db/testing/testDatabase.ts';
import { seedTwoWorkspaces } from './fixtures.ts';
export function recordingSetupSchemaCases() {
  describe('meeting recording setup schema', () => {
    let db:TestDatabase; let workspaceId:string; let meetingId:string;
    beforeAll(async()=>{
      db=await createTestDatabase(); const seeded=await seedTwoWorkspaces(db.session); workspaceId=seeded.alpha.workspaceId;
      meetingId=(await db.session.query<{id:string}>(`INSERT INTO meetings(workspace_id,booking_uid,current_booking_uid,state,starts_at,ends_at,attendee_email,last_event_at) VALUES($1,'recording-schema','recording-schema','booked','2026-10-05T15:00Z','2026-10-05T15:30Z','pm@example.com',now()) RETURNING id`,[workspaceId])).rows[0]!.id;
    });
    afterAll(async()=>{await db.drop();});
    it('scopes operations, constrains state and permits runtime reads and deletion',async()=>{
      const runtime=await db.appRuntimeSession();
      const insert=`INSERT INTO meeting_recording_setup(workspace_id,meeting_id,target,target_hash,state) VALUES($1,$2,'{}',repeat('a',64),$3)`;
      await expect(runtime.query(insert,[workspaceId,meetingId,'bogus'])).rejects.toMatchObject({code:'23514'});
      await expect(runtime.query(insert,['00000000-0000-4000-8000-000000000001',meetingId,'pending'])).rejects.toMatchObject({code:'23503'});
      await runtime.query(insert,[workspaceId,meetingId,'pending']);
      await expect(runtime.query(insert,[workspaceId,meetingId,'pending'])).rejects.toMatchObject({code:'23505'});
      expect((await runtime.query('SELECT state FROM meeting_recording_setup')).rows).toEqual([{state:'pending'}]);
      await runtime.query('DELETE FROM meetings WHERE workspace_id=$1 AND id=$2',[workspaceId,meetingId]);
      expect((await runtime.query('SELECT * FROM meeting_recording_setup')).rows).toEqual([]);
    });
  });
}
