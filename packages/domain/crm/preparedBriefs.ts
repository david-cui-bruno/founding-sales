import {
  businessDate,
  preparedBriefSourcesSchema,
  preparedBriefTextSchema,
  preparedByTextSchema,
  type PreparedBriefDto,
  type PreparedBriefMatch,
  type PreparedBriefMatchRequest,
  type PreparedBriefSetResult,
  type PreparedBriefSource,
} from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { decideAdminOnly, decideFirmMutation } from './authorization.ts';
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
 * Three commands and a read:
 *
 *   * `setPreparedBrief` — an upsert, by the firm's assignee or an admin
 *     (`decideFirmMutation`, after the firm is locked `FOR UPDATE`; that lock is also what
 *     makes two first writes for one firm one insert and one update, never a key
 *     violation). A field left out keeps its stored value, so a save sends only what
 *     changed (kept-state rule K2). The audit row and the answer (which the receipt keeps)
 *     carry the length and the source count, never the text.
 *   * `clearPreparedBrief` — deletes the row; clearing nothing is accepted.
 *   * `matchPreparedBriefRows` — admin only, read-only: which firm each row of an import
 *     file names, by the CSV importer's own `workspaceIndex` and `matchExisting`, not a
 *     copy of them.
 *   * `readPreparedBrief` — the DTO, or null.
 */

export interface SetPreparedBriefInput {
  readonly firmId: string;
  readonly brief?: string | undefined;
  readonly sources?: readonly PreparedBriefSource[] | undefined;
  readonly observedOn?: string | undefined;
  readonly preparedBy?: string | undefined;
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
function inputValid(input: SetPreparedBriefInput): boolean {
  if (input.brief !== undefined && !preparedBriefTextSchema.safeParse(input.brief).success) return false;
  if (input.sources !== undefined && !preparedBriefSourcesSchema.safeParse(input.sources).success) return false;
  if (input.observedOn !== undefined && !businessDate.safeParse(input.observedOn).success) return false;
  if (input.preparedBy !== undefined && !preparedByTextSchema.safeParse(input.preparedBy).success) return false;
  return true;
}

export async function readPreparedBrief(context: RepositoryContext, firmId: string): Promise<PreparedBriefDto | null> {
  const { rows } = await context.db.query<BriefRow>(
    `SELECT ${BRIEF_COLUMNS} FROM firm_prepared_briefs WHERE workspace_id = $1 AND firm_id = $2`,
    [context.scope.workspaceId, firmId],
  );
  const row = rows[0];
  return row === undefined ? null : dtoOf(row);
}

export async function setPreparedBrief(
  context: RepositoryContext,
  input: SetPreparedBriefInput,
): Promise<CrmResult<PreparedBriefSetResult>> {
  if (!inputValid(input)) return refuse('invalid_input');
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);

  const workspaceId = context.scope.workspaceId;
  const existing = await context.db.query<{ present: boolean }>(
    'SELECT true AS present FROM firm_prepared_briefs WHERE workspace_id = $1 AND firm_id = $2',
    [workspaceId, input.firmId],
  );
  const creating = existing.rows.length === 0;
  const sources = input.sources === undefined ? null : JSON.stringify(input.sources.map(source => ({ url: source.url, label: source.label })));

  let written: BriefRow | undefined;
  if (creating) {
    // A first write has to say what the brief is, when it was observed and who prepared it.
    if (input.brief === undefined || input.observedOn === undefined || input.preparedBy === undefined) {
      return refuse('invalid_input');
    }
    const { rows } = await context.db.query<BriefRow>(
      `INSERT INTO firm_prepared_briefs (workspace_id, firm_id, brief, sources, observed_on, prepared_by, updated_by_user_id)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '[]'::jsonb), $5::date, $6, $7)
       RETURNING ${BRIEF_COLUMNS}`,
      [workspaceId, input.firmId, input.brief, sources, input.observedOn, input.preparedBy, actorUserId(context)],
    );
    written = rows[0];
  } else {
    const { rows } = await context.db.query<BriefRow>(
      `UPDATE firm_prepared_briefs
          SET brief = COALESCE($3, brief),
              sources = COALESCE($4::jsonb, sources),
              observed_on = COALESCE($5::date, observed_on),
              prepared_by = COALESCE($6, prepared_by),
              updated_by_user_id = $7,
              updated_at = GREATEST(now(), created_at)
        WHERE workspace_id = $1 AND firm_id = $2
        RETURNING ${BRIEF_COLUMNS}`,
      [
        workspaceId,
        input.firmId,
        input.brief ?? null,
        sources,
        input.observedOn ?? null,
        input.preparedBy ?? null,
        actorUserId(context),
      ],
    );
    written = rows[0];
  }
  if (written === undefined) return refuse('invalid_input');

  const result: PreparedBriefSetResult = {
    firmId: input.firmId,
    created: creating,
    briefLength: written.brief.length,
    sourceCount: written.sources.length,
    updatedAt: written.updated_at.toISOString(),
  };
  // Ids, a length and a count. Never the text and never a URL: the audit log is kept for
  // seven years and cannot be redacted.
  await recordCrmAuditEvent(context, {
    action: 'firm.prepared_brief_set',
    subjectKind: 'firm',
    subjectId: input.firmId,
    detail: {
      created: creating,
      briefLength: result.briefLength,
      sourceCount: result.sourceCount,
      fields: (['brief', 'sources', 'observedOn', 'preparedBy'] as const).filter(field => input[field] !== undefined),
    },
  });
  return accept(result);
}

export async function clearPreparedBrief(
  context: RepositoryContext,
  input: { readonly firmId: string },
): Promise<CrmResult<{ readonly firmId: string; readonly cleared: boolean }>> {
  const firm = await loadFirmForUpdate(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  const removed = await context.db.query(
    'DELETE FROM firm_prepared_briefs WHERE workspace_id = $1 AND firm_id = $2',
    [context.scope.workspaceId, input.firmId],
  );
  const cleared = (removed.rowCount ?? 0) > 0;
  if (cleared) {
    await recordCrmAuditEvent(context, {
      action: 'firm.prepared_brief_cleared',
      subjectKind: 'firm',
      subjectId: input.firmId,
      detail: {},
    });
  }
  return accept({ firmId: input.firmId, cleared });
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
