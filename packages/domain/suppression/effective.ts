import type { SuppressionChannel, SuppressionReaderChannel, SuppressionScope, SuppressionSource } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isSupportedCanonicalizerVersion } from '../src/rules/suppressionCanonicalization.ts';

/**
 * Reading `effective_suppressions` (specification 10.2).
 *
 * "One `effective_suppressions` view is authoritative for email and dialing." So
 * there is one read here and both channels call it; a second query that happened to
 * mean the same thing today is how the two channels end up disagreeing later.
 *
 * `canonicalizerVersionSupported` travels with every answer. Appendix G 21 requires
 * an unsupported canonicalizer change to be refused rather than reinterpreted, and
 * the only way a caller can refuse it is to be told. The direction of the refusal
 * matters: a suppression written by a canonicalizer this build does not understand
 * still *suppresses* — it is read as "this key is suppressed and I cannot reason
 * about it further" — and it is the write paths, correction and supersession, that
 * refuse to act on it.
 */

export interface EffectiveSuppression {
  readonly eventId: string;
  readonly scope: SuppressionScope;
  readonly canonicalKey: string;
  readonly canonicalizerVersion: string;
  readonly canonicalizerVersionSupported: boolean;
  readonly source: SuppressionSource;
  readonly actorUserId: string | null;
  readonly recordedAt: string;
  /** Which channel this stop stops (migration 0037). Every pre-0037 stop is `all`. */
  readonly channel: SuppressionChannel;
}

interface EffectiveRow {
  readonly event_id: string;
  readonly scope: SuppressionScope;
  readonly canonical_key: string;
  readonly canonicalizer_version: string;
  readonly source: SuppressionSource;
  readonly actor_user_id: string | null;
  readonly recorded_at: Date;
  readonly channel: SuppressionChannel;
  readonly [column: string]: unknown;
}

const EFFECTIVE_COLUMNS =
  'event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id, recorded_at, channel';

function toEffective(row: EffectiveRow): EffectiveSuppression {
  return {
    eventId: row.event_id,
    scope: row.scope,
    canonicalKey: row.canonical_key,
    canonicalizerVersion: row.canonicalizer_version,
    canonicalizerVersionSupported: isSupportedCanonicalizerVersion(row.canonicalizer_version),
    source: row.source,
    actorUserId: row.actor_user_id,
    recordedAt: row.recorded_at.toISOString(),
    channel: row.channel,
  };
}

/**
 * The effective suppression covering one key, on any channel, or null.
 *
 * Any channel on purpose: its readers are research (`research/firmState.ts`) and the
 * upgrade test, for which a firm that asked to stop being called is as excluded as one
 * that asked to stop everything (DESIGN-S3X §2.5, unchanged and conservative). The
 * earliest stop of the key is answered.
 */
export async function isSuppressed(
  context: RepositoryContext,
  key: { readonly scope: SuppressionScope; readonly canonicalKey: string },
): Promise<EffectiveSuppression | null> {
  const { rows } = await context.db.query<EffectiveRow>(
    `SELECT ${EFFECTIVE_COLUMNS} FROM effective_suppressions
      WHERE workspace_id = $1 AND scope = $2 AND canonical_key = $3
      ORDER BY recorded_at, event_id
      LIMIT 1`,
    [context.scope.workspaceId, key.scope, key.canonicalKey.toLowerCase()],
  );
  const row = rows[0];
  return row === undefined ? null : toEffective(row);
}

/**
 * The first of several keys that is suppressed, or null.
 *
 * One statement rather than a loop: section 9.2 evaluates "effective firm, number,
 * or relevant contact-handle suppression" as a single step, and a loop would make it
 * several instants with a gap between each.
 *
 * `channel` is the reader's (migration 0037): `email` for the send gate and the send
 * path's fence check, `phone` for dialling and the dial advice. A stop of that channel
 * or of `all` refuses; a stop of the other channel does not. Required, so no reader can
 * forget which channel it is asking about.
 */
export async function firstSuppressed(
  context: RepositoryContext,
  keys: readonly { readonly scope: SuppressionScope; readonly canonicalKey: string }[],
  channel: SuppressionReaderChannel,
): Promise<EffectiveSuppression | null> {
  if (keys.length === 0) return null;
  const scopes = keys.map(key => key.scope);
  const canonicalKeys = keys.map(key => key.canonicalKey.toLowerCase());
  const { rows } = await context.db.query<EffectiveRow>(
    `SELECT ${EFFECTIVE_COLUMNS} FROM effective_suppressions
      WHERE workspace_id = $1
        AND (scope, canonical_key) IN (
          SELECT * FROM unnest($2::text[], $3::text[])
        )
        AND channel IN ($4::text, 'all')
      -- A firm-wide do-not-contact outranks one number: it is the broader fact and
      -- the more useful sentence for a person reading the refusal.
      ORDER BY CASE scope WHEN 'firm' THEN 0 ELSE 1 END, recorded_at, event_id
      LIMIT 1`,
    [context.scope.workspaceId, scopes, canonicalKeys, channel],
  );
  const row = rows[0];
  return row === undefined ? null : toEffective(row);
}

/** Every effective stop, every channel: up to one row per (key, channel) since 0037. */
export async function listEffectiveSuppressions(
  context: RepositoryContext,
  options: { readonly scope?: SuppressionScope; readonly limit?: number } = {},
): Promise<readonly EffectiveSuppression[]> {
  const { rows } = await context.db.query<EffectiveRow>(
    `SELECT ${EFFECTIVE_COLUMNS} FROM effective_suppressions
      WHERE workspace_id = $1 AND ($2::text IS NULL OR scope = $2::text)
      ORDER BY recorded_at DESC, event_id
      LIMIT $3`,
    [context.scope.workspaceId, options.scope ?? null, Math.trunc(options.limit ?? 200)],
  );
  return rows.map(toEffective);
}
