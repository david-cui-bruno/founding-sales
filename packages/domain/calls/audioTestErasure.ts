import type { RepositoryContext } from '../db/workspaceScope.ts';

/** Erase only the bounded destination. Opaque purpose, command, media and uncertain billing history survive. */
export async function eraseExpiredAudioTestDestinations(context: RepositoryContext, sessionId?: string): Promise<number> {
  const eligible = `r.workspace_id=$1 AND r.erased_at IS NULL AND ($2::uuid IS NULL OR EXISTS (
        SELECT 1 FROM call_sessions exact WHERE exact.workspace_id=r.workspace_id AND exact.audio_test_request_id=r.id AND exact.id=$2))
        AND (r.expires_at<=clock_timestamp() OR EXISTS (
          SELECT 1 FROM call_sessions s WHERE s.workspace_id=r.workspace_id AND s.audio_test_request_id=r.id
            AND s.purpose='audio_test' AND s.status IN ('completed','failed','canceled')))`;
  // A sweep can retain the monthly budget lock while a consumer holds this
  // request and waits for that budget. Leave locked requests owed to the next
  // sweep; exact-session callbacks still wait for their own erasure normally.
  const sql = sessionId === undefined
    ? `WITH erase_targets AS (
        SELECT r.id FROM browser_audio_test_requests r WHERE ${eligible}
        FOR UPDATE OF r SKIP LOCKED
      )
      UPDATE browser_audio_test_requests r SET e164=NULL,erased_at=clock_timestamp()
       FROM erase_targets target WHERE r.workspace_id=$1 AND r.id=target.id`
    : `UPDATE browser_audio_test_requests r SET e164=NULL,erased_at=clock_timestamp() WHERE ${eligible}`;
  const result = await context.db.query(
    sql,
    [context.scope.workspaceId, sessionId ?? null],
  );
  return result.rowCount ?? 0;
}
