import { audioTestExecutionReceiptSchema, callSessionCreatedSchema, type AudioTestExecutionReceipt, type AudioTestExecutionReceiptInput } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { requireCallingAuthority, type CallingAuthority } from '../calling/followUpDraftAccess.ts';

/** Exact original receipt, then session, then a fresh principal check. This never resolves a destination or redials. */
export async function readAudioTestExecutionReceipt(
  context: RepositoryContext,
  input: AudioTestExecutionReceiptInput,
  deviceId: string,
  authority: CallingAuthority,
): Promise<AudioTestExecutionReceipt> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') {
    await requireCallingAuthority(context, authority);
    return { state: 'unknown' };
  }
  const receipt = (await context.db.query<{ result_status: string; result: unknown }>(
    `SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
      WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4
        AND d.status='active' AND r.command_kind='create_audio_test_session' AND r.payload_hash=$5`,
    [context.scope.workspaceId, input.commandId, deviceId, actor.userId, input.payloadSHA256],
  )).rows[0];
  let answer: AudioTestExecutionReceipt = { state: 'unknown' };
  if (receipt?.result_status === 'refused') answer = { state: 'refused' };
  else if (receipt?.result_status === 'accepted') {
    const created = callSessionCreatedSchema.safeParse(receipt.result);
    if (created.success) {
      const session = (await context.db.query<{ id: string; status: string; expires_at: Date; consumed_at: Date | null }>(
        `SELECT s.id,s.status,s.expires_at,s.consumed_at FROM call_sessions s
          JOIN browser_audio_test_requests r ON r.workspace_id=s.workspace_id AND r.id=s.audio_test_request_id
         WHERE s.workspace_id=$1 AND s.id=$2 AND s.purpose='audio_test' AND s.actor_user_id=$3
           AND r.actor_user_id=$3 AND r.device_id=$4 AND r.command_id=$5 FOR UPDATE OF s`,
        [context.scope.workspaceId, created.data.sessionId, actor.userId, deviceId, input.commandId],
      )).rows[0];
      if (session && session.expires_at.toISOString() === created.data.expiresAt) {
        const clock = (await context.db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]?.at;
        if (clock) answer = audioTestExecutionReceiptSchema.parse({ state: 'accepted', sessionId: session.id, expiresAt: created.data.expiresAt,
          status: session.consumed_at === null && clock >= session.expires_at ? 'expired_unconsumed' : session.status, canReconnect: false });
      }
    }
  }
  // Session/receipt locks may wait behind retirement, revocation or a role change.
  const device = (await context.db.query("SELECT id FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND status='active' FOR SHARE",
    [context.scope.workspaceId, deviceId, actor.userId])).rows[0];
  await requireCallingAuthority(context, authority);
  return device ? answer : { state: 'unknown' };
}
