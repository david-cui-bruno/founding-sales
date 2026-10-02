import {
  businessDate,
  preparedBriefSourcesSchema,
  preparedBriefTextSchema,
  preparedByTextSchema,
  type PreparedBriefDto,
  type PreparedBriefMatch,
  type PreparedBriefMatchRequest,
  type PreparedBriefImportResult,
  type PreparedBriefImportRow,
  type PreparedBriefImportRowResult,
  type PreparedBriefSource,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { decideAdminOnly } from './authorization.ts';
import { loadFirmForUpdate } from './firms.ts';
import { matchExisting, workspaceIndex, type ImportFirmDraft } from './import.ts';
import { accept, actorUserId, refuse, type CrmResult } from './types.ts';

/**
 * A firm's prepared brief and its sources (lane PB, migration 0038).
 *
 * Text prepared outside Callie — the DFW research agent's call briefs — kept beside
 * Callie's own research brief and never mixed into it: `firm_facts` holds only the firm's
 * own quoted words, and nothing here was read or checked by Callie.
 *
 * Read-only in Callie (scope reduction after review PBR): David asked for the briefs to be
 * accessible from the imported firms, not edited. The only change path is importing a
 * corrected file, which replaces a matched firm's brief whole.
 *
 *   * `matchPreparedBriefRows` — admin only, read-only: which firm each row of an import
 *     file names, by the CSV importer's own `workspaceIndex` and `matchExisting`, not a
 *     copy of them.
 *   * `importPreparedBriefs` — admin only: a whole file (at most 100 rows) as one atomic,
 *     idempotent command, matched with the same matcher (design reset I1). Nothing in it
 *     clears a brief.
 *   * `readPreparedBrief` — the DTO, or null, for the negotiated firm page and Today reads.
 */

/** One brief's fields, as an import row carries them. */
interface BriefFields {
  readonly brief: string;
  readonly sources: readonly PreparedBriefSource[];
  readonly observedOn: string;
  readonly preparedBy: string;
}

interface BriefRow {
  readonly brief: string;
  readonly sources: PreparedBriefSource[];
  readonly observed_on: string;
  readonly prepared_by: string;
  readonly updated_at: Date;
  readonly [column: string]: unknown;
}

const BRIEF_COLUMNS = `brief, sources, to_char(observed_on, 'YYYY-MM-DD') AS observed_on, prepared_by, updated_at`;

function dtoOf(row: BriefRow): PreparedBriefDto {
  return {
    brief: row.brief,
    sources: row.sources.map(source => ({ url: source.url, label: source.label })),
    observedOn: row.observed_on,
    preparedBy: row.prepared_by,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The input's own bounds, the contract's, again: the domain is reached by more than one route. */
function inputValid(input: BriefFields): boolean {
  return (
    preparedBriefTextSchema.safeParse(input.brief).success &&
    preparedBriefSourcesSchema.safeParse(input.sources).success &&
    businessDate.safeParse(input.observedOn).success &&
    preparedByTextSchema.safeParse(input.preparedBy).success
  );
}

export async function readPreparedBrief(context: RepositoryContext, firmId: string): Promise<PreparedBriefDto | null> {
  const { rows } = await context.db.query<BriefRow>(
    `SELECT ${BRIEF_COLUMNS} FROM firm_prepared_briefs WHERE workspace_id = $1 AND firm_id = $2`,
    [context.scope.workspaceId, firmId],
  );
  const row = rows[0];
  return row === undefined ? null : dtoOf(row);
}

/**
 * Which firm each row names, exactly as a CSV import row would be matched to a firm
 * already in the workspace: external id, then website domain, then name, and a key that
 * names two firms is ambiguous. A file never creates a firm, so there is no in-file match.
 */
export async function matchPreparedBriefRows(
  context: RepositoryContext,
  request: PreparedBriefMatchRequest,
): Promise<CrmResult<readonly PreparedBriefMatch[]>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);
  const index = await workspaceIndex(context);
  return accept(
    request.rows.map((row): PreparedBriefMatch => {
      const draft: ImportFirmDraft = {
        name: row.firmName?.trim() ?? '',
        website: row.website?.trim() ?? null,
        addressLine: null,
        locality: null,
        regionCode: null,
        postalCode: null,
        externalId: row.externalId?.trim() ?? null,
        ownerUserId: null,
        timeZone: null,
      };
      const matched = matchExisting(index, draft);
      if (matched.kind === 'none') return { status: 'unmatched' };
      if (matched.kind === 'ambiguous') {
        const column = matched.column === 'external_id' || matched.column === 'website' ? matched.column : 'firm_name';
        return { status: 'ambiguous', column };
      }
      const match = matched.match;
      // `matchExisting` only answers `existing`; `in_file` is the CSV file's own rows.
      if (match.kind !== 'existing') return { status: 'unmatched' };
      return { status: 'matched', firmId: match.firmId, firmName: match.firmName, matchedOn: match.matchedOn };
    }),
  );
}

/** Two source lists are the same list: the same links and labels in the same order. */
function sameSources(a: readonly PreparedBriefSource[], b: readonly PreparedBriefSource[]): boolean {
  return a.length === b.length && a.every((source, i) => source.url === b[i]?.url && source.label === b[i]?.label);
}

/**
 * `POST /firms/brief/import` (design reset I1): a whole prepared-brief file as ONE command.
 *
 * Admin only. Every row is matched with `matchPreparedBriefRows` — the CSV importer's
 * matcher, the same call `/firms/brief/match` answers from — inside the command's own
 * transaction, so what is written is what matched at that instant. A matched row is
 * written in full (it is a file of whole briefs, not a patch), or reported `unchanged` when
 * the stored brief already says exactly that; an unmatched or ambiguous row is skipped with
 * its reason. Nothing here catches a database error: one failure rolls back every row
 * (`runCommand`'s transaction), and the receipt makes a replay answer the stored result.
 * One audit row, with counts only.
 */
export async function importPreparedBriefs(
  context: RepositoryContext,
  input: { readonly rows: readonly PreparedBriefImportRow[] },
): Promise<CrmResult<PreparedBriefImportResult>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);
  for (const row of input.rows) {
    if (!inputValid({ brief: row.brief, sources: row.sources, observedOn: row.observed_on, preparedBy: row.prepared_by })) {
      return refuse('invalid_input');
    }
  }
  const matched = await matchPreparedBriefRows(context, {
    rows: input.rows.map(row => ({
      ...(row.external_id === undefined ? {} : { externalId: row.external_id }),
      ...(row.website === undefined ? {} : { website: row.website }),
      ...(row.firm_name === undefined ? {} : { firmName: row.firm_name }),
    })),
  });
  if (!matched.ok) return refuse(matched.reason);

  const workspaceId = context.scope.workspaceId;
  const results: PreparedBriefImportRowResult[] = [];
  for (const [position, row] of input.rows.entries()) {
    const index = position + 1;
    const match = matched.value[position] ?? { status: 'unmatched' as const };
    if (match.status === 'unmatched') {
      results.push({ index, status: 'unmatched' });
      continue;
    }
    if (match.status === 'ambiguous') {
      results.push({ index, status: 'ambiguous', column: match.column });
      continue;
    }
    // The firm is locked as every brief write locks it, so a concurrent set waits.
    const firm = await loadFirmForUpdate(context, match.firmId);
    if (firm === null || firm.status === 'merged') {
      results.push({ index, status: 'unmatched' });
      continue;
    }
    const sources = row.sources.map(source => ({ url: source.url, label: source.label }));
    const stored = await readPreparedBrief(context, match.firmId);
    if (
      stored !== null &&
      stored.brief === row.brief &&
      stored.observedOn === row.observed_on &&
      stored.preparedBy === row.prepared_by &&
      sameSources(stored.sources, sources)
    ) {
      results.push({ index, status: 'unchanged', firmId: match.firmId });
      continue;
    }
    await context.db.query(
      `INSERT INTO firm_prepared_briefs (workspace_id, firm_id, brief, sources, observed_on, prepared_by, updated_by_user_id)
       VALUES ($1, $2, $3, $4::jsonb, $5::date, $6, $7)
       ON CONFLICT ON CONSTRAINT firm_prepared_briefs_pkey DO UPDATE
         SET brief = EXCLUDED.brief,
             sources = EXCLUDED.sources,
             observed_on = EXCLUDED.observed_on,
             prepared_by = EXCLUDED.prepared_by,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = GREATEST(now(), firm_prepared_briefs.created_at)`,
      [workspaceId, match.firmId, row.brief, JSON.stringify(sources), row.observed_on, row.prepared_by, actorUserId(context)],
    );
    results.push({ index, status: 'saved', firmId: match.firmId });
  }
  const counts = {
    saved: results.filter(result => result.status === 'saved').length,
    unchanged: results.filter(result => result.status === 'unchanged').length,
    unmatched: results.filter(result => result.status === 'unmatched').length,
    ambiguous: results.filter(result => result.status === 'ambiguous').length,
  };
  // Counts only: never a brief, a URL or a firm name.
  await recordCrmAuditEvent(context, {
    action: 'firm.prepared_briefs_imported',
    subjectKind: 'workspace',
    subjectId: workspaceId,
    detail: { rows: input.rows.length, ...counts },
  });
  return accept({ rows: results, counts });
}
