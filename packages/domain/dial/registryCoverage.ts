import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isoMicroseconds } from '../calls/cadence.ts';

interface Snapshot {
  readonly [column: string]: unknown;
  readonly id: string;
  readonly downloaded_at: Date;
  readonly published_at: Date;
  readonly complete: boolean;
  readonly revoked_at: Date | null;
}
export type RegistryDecision =
  | { readonly ok: true; readonly snapshotId: string; readonly scrubbedAt: string; readonly freshUntil: string; readonly at: string }
  | { readonly ok: false; readonly reason: 'dnc_coverage_unknown' | 'dnc_registry_match' };

/** Caller holds workspace admission gate before this lock. No fallback to older clear data. */
export async function readPhoneRegistryDecision(context: RepositoryContext, e164: string, testAt?: string): Promise<RegistryDecision> {
  // Only US-format NANP coverage is representable here. This is NOT line-type proof.
  if (!/^\+1[2-9][0-9]{9}$/u.test(e164)) return { ok: false, reason: 'dnc_coverage_unknown' };
  const w = context.scope.workspaceId;
  const result = await context.db.query<Snapshot>(
    `SELECT id,downloaded_at,published_at,complete,revoked_at FROM national_registry_snapshots
     WHERE workspace_id=$1 AND published_at IS NOT NULL AND $2=ANY(covered_area_codes)
     ORDER BY published_at DESC,id DESC LIMIT 1 FOR SHARE`, [w, e164.slice(2, 5)]);
  const snapshot = result.rows[0];
  if (!snapshot) return { ok: false, reason: 'dnc_coverage_unknown' };
  const scrub = (await context.db.query<{ scrubbed_at: Date; result: string }>(
    `SELECT scrubbed_at,result FROM national_registry_endpoint_scrubs WHERE workspace_id=$1 AND snapshot_id=$2 AND e164=$3`,
    [w, snapshot.id, e164])).rows[0];
  // Sample wall time after the scrub read, which may itself wait.
  const clock = await context.db.query<{ at: string }>(`SELECT ${isoMicroseconds('clock_timestamp()')} AS at`);
  const at = testAt ?? clock.rows[0]?.at;
  if (!at) return { ok: false, reason: 'dnc_coverage_unknown' };
  const now = Date.parse(at);
  const download = snapshot.downloaded_at.getTime();
  const freshUntil = download + 31 * 86_400_000;
  // A known match is never clearance, even when other evidence is unusable.
  if (scrub?.result === 'match') return { ok: false, reason: 'dnc_registry_match' };
  if (!snapshot.complete || snapshot.revoked_at !== null || download > now || snapshot.published_at.getTime() > now ||
      now >= freshUntil || !scrub || scrub.result !== 'clear' || scrub.scrubbed_at.getTime() < download || scrub.scrubbed_at.getTime() > now) {
    return { ok: false, reason: 'dnc_coverage_unknown' };
  }
  return { ok: true, snapshotId: snapshot.id, scrubbedAt: scrub.scrubbed_at.toISOString(), freshUntil: new Date(freshUntil).toISOString(), at };
}
