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
  command_receipts: [
    ['workspace_id', 'device_id', 'command_id'],
    // Migration 0003: one command id per workspace, so a second device presenting a
    // command id another device already used is refused by the database.
    ['workspace_id', 'command_id'],
  ],
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

  // Migration 0002. `critical_alerts` also has a partial unique index on
  // (workspace_id, alert_key) WHERE resolved_at IS NULL; a partial index is not
  // declarable here, because the registry promises an unconditional unique key.
  canary_runs: [['workspace_id', 'quarter_hour']],
  critical_alerts: [['workspace_id', 'id']],

  // Migration 0003. `oidc_authorization_requests` is deliberately absent: it is looked up before
  // there is an authenticated caller, so it has no workspace-scoped key at all.
  // See docs/decisions/g2-oidc-request-lookup.md.
  sessions: [
    ['workspace_id', 'id'],
    ['workspace_id', 'access_token_hash'],
  ],
  device_refresh_credentials: [['workspace_id', 'device_id', 'generation']],

  // Migration 0004 (lane G3a). The three-column keys are the *semantic composite
  // keys* of specification 7.2: a child row names `(workspace_id, contact_id,
  // firm_id)` or `(workspace_id, opportunity_id, firm_id)`, so it cannot mix firms.
  // `contacts` and `opportunities` therefore declare both their own id and the
  // semantic key, and a lookup by either typechecks.
  //
  // The partial unique indexes — one open opportunity per firm, one active primary
  // contact per firm, one terminal stage of each kind — are deliberately absent: the
  // registry promises unconditional unique keys, and a partial index is not one.
  firms: [['workspace_id', 'id']],
  contacts: [
    ['workspace_id', 'id'],
    ['workspace_id', 'id', 'firm_id'],
  ],
  phone_routes: [
    ['workspace_id', 'id'],
    ['workspace_id', 'firm_id', 'contact_id', 'e164'],
  ],
  email_addresses: [
    ['workspace_id', 'id'],
    ['workspace_id', 'firm_id', 'contact_id', 'address'],
  ],
  evidence_items: [
    ['workspace_id', 'id'],
    ['workspace_id', 'firm_id', 'contact_id', 'provider', 'content_hash'],
  ],
  pipeline_stages: [
    ['workspace_id', 'id'],
    ['workspace_id', 'key'],
  ],
  opportunities: [
    ['workspace_id', 'id'],
    ['workspace_id', 'id', 'firm_id'],
  ],
  opportunity_stage_events: [['workspace_id', 'id']],
  record_aliases: [['workspace_id', 'id']],
  record_merge_events: [
    ['workspace_id', 'id'],
    ['workspace_id', 'record_kind', 'source_id'],
  ],
  crm_domain_events: [
    ['workspace_id', 'id'],
    ['workspace_id', 'event_kind', 'dedupe_key'],
  ],

  // Migration 0006 (lane G4). `suppression_finalizations` is keyed by the event it
  // decides rather than by an id of its own: there is one decision per event, and
  // making that the primary key is what lets the correction and the finalizer race
  // for it with a single insert.
  //
  // `dial_tickets(workspace_id, command_id)` and `call_logs(workspace_id,
  // command_id)` are the command-replay keys of 5.3. The call log's column is
  // nullable — a call recorded by a job carries no command id — which a unique
  // index treats as distinct and a lookup by it simply never matches.
  //
  // Deliberately absent: `calling_windows_one_current`, which is partial, and the
  // posture exclusion constraint, which is not a unique index at all.
  state_postures: [
    ['workspace_id', 'id'],
    ['workspace_id', 'state', 'revision'],
  ],
  calling_windows: [
    ['workspace_id', 'id'],
    ['workspace_id', 'version'],
  ],
  suppression_finalizations: [['workspace_id', 'event_id']],
  dial_tickets: [
    ['workspace_id', 'id'],
    ['workspace_id', 'command_id'],
  ],
  call_logs: [
    ['workspace_id', 'id'],
    ['workspace_id', 'command_id'],
  ],
  callbacks: [['workspace_id', 'id']],

  // Migration 0008 (lane G6). The card's declared key *is* section 8.2's
  // `UNIQUE(workspace_id, snapshot_date, firm_id)`, because that triple is the card's
  // identity and it is the primary key: a firm appears once on a date, and a
  // surrogate id would only be a second way to name the same row.
  //
  // `today_snoozes_one_active` is deliberately absent: it is partial, and the
  // registry promises unconditional unique keys.
  today_snapshots: [['workspace_id', 'snapshot_date', 'firm_id']],
  today_items: [
    ['workspace_id', 'id'],
    ['workspace_id', 'snapshot_date', 'firm_id', 'item_key'],
  ],
  today_snoozes: [['workspace_id', 'id']],
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
  'canary_runs',
  'command_receipts',
  'critical_alerts',
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
