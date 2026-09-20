/**
 * The declared lookup keys of every workspace-scoped table.
 *
 * Specification section 6: "no method accepts a bare object ID; lookup uniqueness
 * includes the workspace". This registry is how that becomes a compile error rather
 * than a code-review note. Every tuple here:
 *
 *   * begins with `workspace_id`, which the scope supplies and the caller never types;
 *   * corresponds to a real UNIQUE constraint or unique index in the database, which
 *     test/db/workspaceScope.test.ts checks against pg_catalog row by row.
 *
 * `LookupKey<'command_receipts'>` is therefore `{ device_id, command_id }` and nothing
 * else: `{ id }` does not typecheck, and neither does a key that omits a column.
 */

export const FOUNDATION_LOOKUP_KEYS = {
  workspace_memberships: [
    ['workspace_id', 'id'],
    ['workspace_id', 'user_id'],
  ],
  devices: [['workspace_id', 'id']],
  calling_identities: [
    ['workspace_id', 'id'],
    ['workspace_id', 'e164'],
  ],
  command_receipts: [['workspace_id', 'device_id', 'command_id']],
  audit_events: [['workspace_id', 'id']],
  suppression_events: [['workspace_id', 'event_id']],
  active_holds: [['workspace_id', 'id']],
  administrative_pauses: [['workspace_id', 'id']],
  retention_policies: [
    ['workspace_id', 'id'],
    ['workspace_id', 'data_kind'],
  ],
  jobs: [
    ['workspace_id', 'id'],
    ['workspace_id', 'kind', 'idempotency_key'],
  ],
  daily_counters: [
    ['workspace_id', 'subject_kind', 'subject_key', 'counter_kind', 'business_date'],
  ],
} as const satisfies Readonly<Record<string, readonly (readonly ['workspace_id', ...string[]])[]>>;

/** A table a scoped repository may read. `workspaces`, `users` and `heartbeats` are not scoped rows. */
export type ScopedTable = keyof typeof FOUNDATION_LOOKUP_KEYS;

export const SCOPED_TABLES = Object.keys(FOUNDATION_LOOKUP_KEYS) as readonly ScopedTable[];

/**
 * Tables the foundation migration creates, scoped and unscoped alike. Used by the
 * migration test; `users`, `workspaces`, `heartbeats`, `system_generations` and
 * `hold_reason_codes` are deliberately not in FOUNDATION_LOOKUP_KEYS.
 */
export const FOUNDATION_TABLES = [
  'active_holds',
  'administrative_pauses',
  'audit_events',
  'calling_identities',
  'command_receipts',
  'daily_counters',
  'devices',
  'heartbeats',
  'hold_reason_codes',
  'jobs',
  'retention_policies',
  'suppression_events',
  'system_generations',
  'users',
  'workspace_memberships',
  'workspaces',
] as const;

/** Values a lookup key column may carry. Dates are passed through as `Date`. */
export type LookupValue = string | number | boolean | Date;

type KeyTuplesOf<Table extends ScopedTable> = (typeof FOUNDATION_LOOKUP_KEYS)[Table][number];

type KeyObject<Tuple extends readonly string[]> = {
  readonly [Column in Exclude<Tuple[number], 'workspace_id'>]: LookupValue;
};

/**
 * The key object a lookup on `Table` accepts: one of that table's declared unique
 * keys, minus `workspace_id`, which comes from the scope. Distributes over the union
 * of tuples, so a table with two keys accepts either shape and nothing between them.
 */
export type LookupKey<Table extends ScopedTable> =
  KeyTuplesOf<Table> extends infer Tuple
    ? Tuple extends readonly string[]
      ? KeyObject<Tuple>
      : never
    : never;

/** The declared key tuples of a table, at runtime. */
export function lookupKeysOf(table: ScopedTable): readonly (readonly string[])[] {
  return FOUNDATION_LOOKUP_KEYS[table];
}

/**
 * Which declared key the given column names are, or null. The repository helper uses
 * this so a key assembled at runtime (an import row, a replayed command) is still
 * checked against the registry rather than concatenated into a WHERE clause.
 */
export function matchLookupKey(table: ScopedTable, columns: readonly string[]): readonly string[] | null {
  const wanted = [...columns].sort();
  for (const declared of lookupKeysOf(table)) {
    const rest = declared.filter(column => column !== 'workspace_id').sort();
    if (rest.length === wanted.length && rest.every((column, index) => column === wanted[index])) return declared;
  }
  return null;
}
