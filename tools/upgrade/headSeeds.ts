import type { SessionQueryable } from '@fss/domain/db/queryable.ts';

/**
 * Rows HEAD adds to the fixture at N, in N's own column list, before the snapshot.
 *
 * The fixture is written by the base checkout's own loader, so a row shape the base's
 * code never produced cannot come from there — yet the migration under test has to meet
 * it, because production can hold it. The case that made this file: schema 25 lets a
 * `follow_up_permissions` row be spent (`consumed_at` set) and 0026 adds a CHECK pairing
 * `consumed_at` with a new `consumed_reason`, so 0026 must backfill the reason first
 * (review of PR 335, P1-1). The base's fixture holds no spent permission, and a run
 * without one would pass whether the backfill existed or not.
 *
 * Each seed is plain SQL against schema N — never HEAD's domain code, which writes
 * schema M — and names the versions it applies to. After the upgrade its `verify` reads
 * the row back and says what is wrong, or null. A seed changes rows in a table the
 * snapshot then records, so step 6 sees the migration's effect on it like any other.
 */
export interface HeadSeed {
  readonly name: string;
  /** The base schemas this seed is written for: its SQL uses exactly their columns. */
  readonly fromVersions: readonly number[];
  readonly seed: (session: SessionQueryable) => Promise<string>;
  readonly verify: (session: SessionQueryable, seededId: string) => Promise<string | null>;
}

export const HEAD_SEEDS: readonly HeadSeed[] = Object.freeze([
  {
    name: 'spent follow-up permission (0026 backfills consumed_reason)',
    fromVersions: [25],
    seed: async session => {
      const { rows } = await session.query<{ id: string }>(
        `INSERT INTO follow_up_permissions
           (workspace_id, firm_id, contact_id, kind, scope, booking_reference, max_steps,
            expires_at, granted_by_user_id, consumed_at)
         SELECT c.workspace_id, c.firm_id, c.id, 'request', 'contextual_reply', 'upgrade-spent-0026', 1,
                now() + interval '14 days', m.user_id, now()
           FROM contacts c
           JOIN workspace_memberships m ON m.workspace_id = c.workspace_id
          ORDER BY c.created_at, c.id, m.user_id
          LIMIT 1
         RETURNING id`,
      );
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the fixture has no contact to hang a spent permission on');
      return id;
    },
    verify: async (session, seededId) => {
      const { rows } = await session.query<{ consumed_reason: string | null; consumed_at: Date | null }>(
        'SELECT consumed_reason, consumed_at FROM follow_up_permissions WHERE id = $1',
        [seededId],
      );
      const row = rows[0];
      if (row === undefined) return 'the spent permission is gone';
      if (row.consumed_at === null) return 'the spent permission lost its consumed_at';
      if (row.consumed_reason !== 'sent') return `consumed_reason is ${String(row.consumed_reason)}, expected sent`;
      return null;
    },
  },
]);

export function seedsFor(fromVersion: number): readonly HeadSeed[] {
  return HEAD_SEEDS.filter(seed => seed.fromVersions.includes(fromVersion));
}
