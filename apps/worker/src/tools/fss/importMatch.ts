import { uuid } from '@fss/contracts';
import type { AdminInvocation, AdminOutcome } from './admin.ts';

/**
 * `fss admin import-match report --workspace-id <uuid> --external-id-prefix <prefix>`: whether
 * the firms a CSV import names by external id are in the workspace, as counts only.
 *
 * Why it exists: in production a prepared-brief file previewed as every row unmatched, while
 * the same CSV and the same file match every row on a fresh database (lane PBM). Production
 * has no read-only SQL path, so this is the read that tells "the import never committed" from
 * "the firms are there and the matcher missed them". The CSV importer keeps a firm's external
 * id as a `record_aliases` row of kind `external_id` (`createFirm`), which is what the
 * importer's matcher, and so the prepared-brief match, look it up by.
 *
 * It prints one JSON line of five counts and nothing else: no name, website, id or alias
 * value, because the operations task's log is CloudWatch. The prefix is at least four
 * characters of `[a-z0-9-]` (at most 64), so it cannot be a pattern and cannot be empty.
 * One READ ONLY transaction, rolled back; it writes nothing and decides nothing.
 */
export const IMPORT_MATCH_PREFIX = /^[a-z0-9-]{4,64}$/u;

export async function importMatchReportCommand(invocation: AdminInvocation): Promise<AdminOutcome> {
  const workspaceId = invocation.options['--workspace-id'] ?? '';
  const prefix = invocation.options['--external-id-prefix'] ?? '';
  if (!uuid.safeParse(workspaceId).success) {
    return { ok: false, reason: 'workspace_unknown', detail: '--workspace-id is a workspace uuid' };
  }
  if (!IMPORT_MATCH_PREFIX.test(prefix)) {
    return { ok: false, reason: 'prefix_invalid', detail: '--external-id-prefix is 4 to 64 characters of a-z, 0-9 and -' };
  }
  const { session } = invocation;
  await session.query('BEGIN TRANSACTION READ ONLY');
  try {
    const workspace = await session.query('SELECT 1 FROM workspaces WHERE id = $1::uuid', [workspaceId]);
    if (workspace.rows.length === 0) return { ok: false, reason: 'workspace_unknown', detail: 'no workspace has that id' };
    const firms = await session.query<{ active: string; recent: string }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::text AS active,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::text AS recent
         FROM firms
        WHERE workspace_id = $1::uuid`,
      [workspaceId],
    );
    const aliases = await session.query<{ total: string; active: string; merged: string }>(
      `SELECT count(*)::text AS total,
              count(*) FILTER (WHERE f.status = 'active')::text AS active,
              count(*) FILTER (WHERE f.status = 'merged')::text AS merged
         FROM record_aliases a
         LEFT JOIN firms f ON f.workspace_id = a.workspace_id AND f.id = a.firm_id
        WHERE a.workspace_id = $1::uuid
          AND a.record_kind = 'firm'
          AND a.alias_kind = 'external_id'
          AND starts_with(a.alias_value, $2)`,
      [workspaceId, prefix],
    );
    const count = (value: string | undefined): number => Number(value ?? '0');
    return {
      ok: true,
      value: {
        activeFirms: count(firms.rows[0]?.active),
        externalIdAliases: count(aliases.rows[0]?.total),
        aliasesOnActiveFirms: count(aliases.rows[0]?.active),
        aliasesOnMergedFirms: count(aliases.rows[0]?.merged),
        firmsCreatedLast7Days: count(firms.rows[0]?.recent),
      },
    };
  } finally {
    await session.query('ROLLBACK');
  }
}
