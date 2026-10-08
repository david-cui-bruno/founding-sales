import { randomUUID } from 'node:crypto';
import type { IdentityCase, IdentityCaseFixture } from './identityCases.ts';

async function insert(f: IdentityCaseFixture, changes: Record<string, unknown> = {}) {
  const row = { workspace_id: f.seeded.alpha.workspaceId, attempt_id: randomUUID(), user_id: f.seeded.alpha.salesperson.userId,
    device_id: f.seeded.alpha.salesperson.deviceId, event_key: randomUUID(), action_id: 'reply-message:fixture', phase: 'attention',
    target: JSON.stringify({ kind: 'reply', firmId: randomUUID(), messageId: randomUUID() }), attempted_at: '2026-10-08T03:00:00Z', ...changes };
  return await f.session.query(`INSERT INTO actionable_notification_attempts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_, i) => `$${String(i + 1)}`).join(',')})`, Object.values(row));
}

/** The catalog's mandatory failing-row seam: each row violates one 0066 invariant. */
export const NOTIFICATION_CONSTRAINT_CASES: readonly IdentityCase[] = [
  { constraint: 'actionable_notification_attempts_pkey', run: async f => { const id = randomUUID(); await insert(f, { attempt_id: id }); return insert(f, { attempt_id: id }); } },
  { constraint: 'actionable_notification_attem_workspace_id_user_id_event_ke_key', run: async f => { await insert(f, { event_key: 'same-user-event' }); return insert(f, { event_key: 'same-user-event' }); } },
  { constraint: 'actionable_notification_attempts_workspace_id_user_id_fkey', run: f => insert(f, { user_id: f.seeded.beta.salesperson.userId }) },
  { constraint: 'actionable_notification_attempts_workspace_id_device_id_fkey', run: f => insert(f, { device_id: f.seeded.beta.salesperson.deviceId }) },
  { constraint: 'actionable_notification_attempts_event_key_check', run: f => insert(f, { event_key: '' }) },
  { constraint: 'actionable_notification_attempts_action_id_check', run: f => insert(f, { action_id: '' }) },
  { constraint: 'actionable_notification_attempts_phase_check', run: f => insert(f, { phase: 'routine_progress' }) },
  { constraint: 'actionable_notification_attempts_target_check', run: f => insert(f, { target: JSON.stringify({ kind: 'reply', firmId: randomUUID(), messageId: randomUUID(), body: 'must not persist' }) }) },
  { constraint: 'actionable_notification_attempts_status_check', run: f => insert(f, { status: 'delivered' }) },
  { constraint: 'actionable_notification_attempts_check', run: f => insert(f, { status: 'acknowledged' }) },
  { constraint: 'actionable_notification_attempts_check1', run: f => insert(f, { status: 'native_shown' }) },
  { constraint: 'actionable_notification_attempts_check2', run: f => insert(f, { status: 'failed' }) },
  { constraint: 'actionable_notification_attempts_check3', run: f => insert(f, { status: 'unknown' }) },
];
