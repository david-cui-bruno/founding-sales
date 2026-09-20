import { describe, expect, it } from 'vitest';
import { FOUNDATION_LOOKUP_KEYS, SCOPED_TABLES } from '@fss/domain/db';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 8: "Two workspaces with colliding external ids: reads, writes, receipts,
 * messages and jobs never cross."
 *
 * Five lane suites exercise it — the workspace-scope suite row by row against
 * `pg_catalog`, the mail and outbound suites on a shared Pub/Sub message id and a
 * shared step-execution id, and the identity suite on two users who share a display
 * email. They all start from `seedTwoWorkspaces`. What they cannot show is that the
 * *API* makes crossing unsayable rather than merely untested, so this check reads the
 * lookup-key registry and asserts the shape section 6 demands: no lookup anywhere
 * begins without the workspace.
 *
 * ## The vacuous-pass trap
 *
 * Two workspaces whose every identifier differs cross nothing by luck, and a fixture
 * built that way would make the whole scenario decorative. The fixture closes it by
 * deliberately colliding four things — `collidingCommandId`, `collidingE164`,
 * `collidingJobKey` and a shared display email — so every one of those tests is
 * asking a question the database could get wrong. This check closes the other end: a
 * registry entry of `['id']` would let a caller look a row up by its bare identifier
 * and is asserted impossible, tuple by tuple.
 */

describe('Appendix G 8: nothing is addressable without its workspace', () => {
  mustCover(8, ['seedTwoWorkspaces', 'collidingCommandId', 'collidingE164', 'collidingJobKey']);

  it('begins every declared lookup key with workspace_id', () => {
    // Section 6: "no method accepts a bare object ID; lookup uniqueness includes the
    // workspace." A tuple that started anywhere else would compile and would be a
    // cross-workspace read waiting for a colliding id.
    const entries = Object.entries(FOUNDATION_LOOKUP_KEYS);
    expect(entries.length).toBeGreaterThan(20);
    expect(entries.length).toBe(SCOPED_TABLES.length);
    for (const [table, keys] of entries) {
      const declared: readonly (readonly string[])[] = keys;
      expect(declared.length, `${table} declares no lookup key`).toBeGreaterThan(0);
      for (const key of declared) {
        // `['workspace_id']` alone is legitimate for a per-workspace singleton such
        // as `research_settings`. `['id']` is what section 6 forbids, and it is
        // forbidden by the position rather than by a list of exceptions.
        expect(key[0], `${table} declares the lookup key ${key.join(', ')}`).toBe('workspace_id');
        expect(key.slice(1), `${table} repeats the workspace column`).not.toContain('workspace_id');
      }
      // Two identical tuples would mean one of them had been edited into the other,
      // losing a lookup shape the callers still use.
      const shapes = declared.map(key => key.join('+'));
      expect(new Set(shapes).size, `${table} declares the same key twice`).toBe(shapes.length);
    }
  });

  it('keys the three colliding identifiers on more than the colliding value', () => {
    const joined = (keys: readonly (readonly string[])[]): string[] => keys.map(key => key.join('+'));

    // The command id, the calling number and the job idempotency key are exactly the
    // three the fixture makes identical across the two workspaces, and each is unique
    // only within one.
    expect(joined(FOUNDATION_LOOKUP_KEYS.command_receipts)).toContain('workspace_id+command_id');
    expect(joined(FOUNDATION_LOOKUP_KEYS.calling_identities)).toContain('workspace_id+e164');
    expect(joined(FOUNDATION_LOOKUP_KEYS.jobs)).toContain('workspace_id+kind+idempotency_key');
    // The fourth colliding value, the shared display email, is not a key at all:
    // `users` is not workspace-scoped and its email is display data.
    expect(SCOPED_TABLES as readonly string[]).not.toContain('users');
  });
});
