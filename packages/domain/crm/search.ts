import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmRead, type FirmReadVisibility } from './authorization.ts';
import { firmIdentityDtoOf, type FirmIdentityDto } from './dto.ts';
import { accept, refuse, type CrmResult, type FirmRow, type RouteEligibility } from './types.ts';

/**
 * CRM search and filters (specification 7.2, 14.1 and Appendix F).
 *
 * "Search covers firms, contacts, domains, addresses, and phone numbers. Filters
 * cover owner, stage, sequence status, hold reason, route eligibility, and activity
 * date."
 *
 * Two rules decide the shape of everything here.
 *
 * **The fields a term is matched against are the caller's visibility class.** Not the
 * results — the *fields*. Appendix F gives a salesperson a colleague's firm at
 * identity visibility only, and a search that matched a colleague's prospect's email
 * address and then handed back the narrow DTO would still have told the salesperson
 * that the address is at that firm. That is the fact the matrix withholds, and a
 * search box is the easiest place in a CRM to give it away. So `WIDE_FIELDS` are
 * matched only for the firms this caller may read in detail, and the SQL says so in
 * one place. See docs/decisions/g3b-search-visibility.md.
 *
 * **Every hit reports what it matched on, and never the matching value.** A colleague
 * learns "this firm matched on its name"; the assignee learns "matched on a phone
 * route". Neither is given the text, because for the narrow class the text is the
 * redacted thing and for the wide class the caller can read the record anyway.
 *
 * One statement, one round trip, every parameter bound. `ILIKE` with the trigram
 * indexes of migration 0005 rather than `to_tsquery`: the questions a CRM search box
 * is asked are fragments — half a name, a domain without its scheme, the last seven
 * digits of a number — and a lexeme index answers none of them.
 */

/** What a hit matched on. Field kinds, never values. */
export const SEARCH_MATCH_FIELDS = [
  'name',
  'domain',
  'locality',
  'alias',
  'address',
  'contact',
  'email',
  'phone',
] as const;
export type SearchMatchField = (typeof SEARCH_MATCH_FIELDS)[number];

/** The match fields Appendix F row 1 allows for a firm the caller is not assigned. */
export const NARROW_MATCH_FIELDS: readonly SearchMatchField[] = ['name', 'domain', 'locality', 'alias'];
/** The rest. Only for the assignee, an admin, or the system. */
export const WIDE_MATCH_FIELDS: readonly SearchMatchField[] = ['address', 'contact', 'email', 'phone'];

/**
 * The sequence-status filter (7.2), answered honestly while lane G8 does not exist.
 *
 * There is no enrollment table, so no firm is enrolled: `none` restricts nothing and
 * `active`/`stopped` match nothing. That is the truth about this database rather than
 * a stub, and `test/crm/search.test.ts` fails the moment `sequence_enrollments`
 * appears, so the branch below cannot quietly go on being wrong.
 */
export const SEQUENCE_STATUS_FILTERS = ['any', 'none', 'active', 'stopped'] as const;
export type SequenceStatusFilter = (typeof SEQUENCE_STATUS_FILTERS)[number];

export interface SearchFilters {
  /** By assignee, or by having none. Both, or neither, is `invalid_input`. */
  readonly owner?: { readonly userId?: string; readonly unassigned?: boolean };
  /** The stage key of the firm's open opportunity. Refused when the workspace has no such stage. */
  readonly stageKey?: string;
  readonly sequenceStatus?: SequenceStatusFilter;
  /** A code from `hold_reason_codes`; the hold must be on the firm and unreleased. */
  readonly holdReasonCode?: string;
  /** The firm has at least one route, of either kind, at this eligibility. */
  readonly routeEligibility?: RouteEligibility;
  readonly activeSince?: Date;
  readonly activeUntil?: Date;
}

export interface SearchInput {
  /** A fragment. Absent or blank means "every firm this caller may see". */
  readonly term?: string;
  readonly filters?: SearchFilters;
  readonly limit?: number;
}

export interface SearchHit {
  readonly visibility: FirmReadVisibility;
  readonly firm: FirmIdentityDto;
  /** In `SEARCH_MATCH_FIELDS` order. Empty when the search had no term. */
  readonly matchedOn: readonly SearchMatchField[];
  /**
   * The most recent business instant recorded for this firm. Appendix F row 1 covers
   * "pipeline stage/dates", so every active member may see it.
   */
  readonly lastActivityAt: string;
}

export interface SearchOutcome {
  readonly hits: readonly SearchHit[];
  /** True when the limit cut the answer short, so a caller can narrow rather than page blindly. */
  readonly truncated: boolean;
}

export const DEFAULT_SEARCH_LIMIT = 50;
export const MAX_SEARCH_LIMIT = 500;

/**
 * Turn a person's fragment into a `LIKE` pattern that is only ever text.
 *
 * `%`, `_` and the escape character itself are the three ways a term stops being a
 * term. A search for `%` should find the firms whose name contains a per-cent sign,
 * which is none of them, rather than every firm in the workspace.
 */
export function likePattern(term: string): string {
  return `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

/** The digits of a term, for matching a number a person typed with punctuation. */
function digitsOf(term: string): string | null {
  const digits = term.replaceAll(/[^0-9]/gu, '');
  return digits.length >= 4 ? `%${digits}%` : null;
}

interface SearchRow extends FirmRow {
  readonly stage_key: string | null;
  readonly opportunity_status: 'open' | 'won' | 'lost' | null;
  readonly control_mode: 'automated' | 'manual' | null;
  readonly opened_at: Date | null;
  readonly last_activity_at: Date;
  readonly wide: boolean;
  readonly m_name: boolean;
  readonly m_domain: boolean;
  readonly m_locality: boolean;
  readonly m_alias: boolean;
  readonly m_address: boolean;
  readonly m_contact: boolean;
  readonly m_email: boolean;
  readonly m_phone: boolean;
}

function matchedOn(row: SearchRow): readonly SearchMatchField[] {
  const flags: Readonly<Record<SearchMatchField, boolean>> = {
    name: row.m_name,
    domain: row.m_domain,
    locality: row.m_locality,
    alias: row.m_alias,
    address: row.m_address,
    contact: row.m_contact,
    email: row.m_email,
    phone: row.m_phone,
  };
  return SEARCH_MATCH_FIELDS.filter(field => flags[field]);
}

async function stageExists(context: RepositoryContext, key: string): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    'SELECT true AS present FROM pipeline_stages WHERE workspace_id = $1 AND key = $2',
    [context.scope.workspaceId, key],
  );
  return rows.length > 0;
}

async function holdReasonExists(context: RepositoryContext, code: string): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    'SELECT true AS present FROM hold_reason_codes WHERE code = $1',
    [code],
  );
  return rows.length > 0;
}

export async function searchFirms(context: RepositoryContext, input: SearchInput): Promise<CrmResult<SearchOutcome>> {
  const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) return refuse('invalid_input');

  const filters = input.filters ?? {};
  if (filters.owner !== undefined) {
    const named = filters.owner.userId !== undefined;
    const unassigned = filters.owner.unassigned === true;
    if (named === unassigned) return refuse('invalid_input');
  }
  if (filters.stageKey !== undefined && !(await stageExists(context, filters.stageKey))) {
    return refuse('stage_unknown');
  }
  if (filters.holdReasonCode !== undefined && !(await holdReasonExists(context, filters.holdReasonCode))) {
    return refuse('invalid_input');
  }

  const values: unknown[] = [];
  const bind = (value: unknown): string => `$${String(values.push(value))}`;

  const workspace = bind(context.scope.workspaceId);
  const actor = context.scope.actor;
  // The system acts for the workspace and an admin may read everything; a salesperson
  // reaches the wide fields of their own firms only. One expression, used once.
  const wide =
    actor.kind === 'system' || actor.role === 'admin' ? 'true' : `f.assigned_user_id = ${bind(actor.userId)}`;

  const term = (input.term ?? '').trim();
  const hasTerm = term.length > 0;
  const pattern = hasTerm ? bind(likePattern(term)) : null;
  const digits = hasTerm ? digitsOf(term) : null;
  const digitPattern = digits === null ? null : bind(digits);

  const flag = (sql: string): string => (pattern === null ? 'false' : sql);
  const aliasMatch = (kinds: readonly string[]): string =>
    `EXISTS (SELECT 1 FROM record_aliases ra
              WHERE ra.workspace_id = f.workspace_id AND ra.firm_id = f.id
                AND ra.alias_kind = ANY (ARRAY[${kinds.map(kind => `'${kind}'`).join(', ')}]::text[])
                AND ra.alias_value ILIKE ${String(pattern)})`;

  const flags = [
    `${flag(`f.name ILIKE ${String(pattern)}`)} AS m_name`,
    `${flag(`(COALESCE(f.website, '') ILIKE ${String(pattern)} OR ${aliasMatch(['domain'])})`)} AS m_domain`,
    `${flag(`(COALESCE(f.locality, '') ILIKE ${String(pattern)} OR COALESCE(f.region_code, '') ILIKE ${String(pattern)})`)} AS m_locality`,
    `${flag(aliasMatch(['name', 'external_id']))} AS m_alias`,
    `${flag(`(${wide}) AND (COALESCE(f.address_line, '') ILIKE ${String(pattern)} OR COALESCE(f.postal_code, '') ILIKE ${String(pattern)})`)} AS m_address`,
    `${flag(`(${wide}) AND EXISTS (SELECT 1 FROM contacts c
              WHERE c.workspace_id = f.workspace_id AND c.firm_id = f.id AND c.full_name ILIKE ${String(pattern)})`)} AS m_contact`,
    `${flag(`(${wide}) AND (EXISTS (SELECT 1 FROM email_addresses ea
              WHERE ea.workspace_id = f.workspace_id AND ea.firm_id = f.id AND ea.address ILIKE ${String(pattern)})
              OR ${aliasMatch(['email'])})`)} AS m_email`,
    `${flag(`(${wide}) AND (EXISTS (SELECT 1 FROM phone_routes pr
              WHERE pr.workspace_id = f.workspace_id AND pr.firm_id = f.id
                AND (pr.e164 ILIKE ${String(pattern)}${digitPattern === null ? '' : ` OR pr.e164 ILIKE ${digitPattern}`}))
              OR ${aliasMatch(['phone'])})`)} AS m_phone`,
  ];

  const conditions: string[] = [];
  if (filters.owner?.userId !== undefined) conditions.push(`matched.assigned_user_id = ${bind(filters.owner.userId)}`);
  if (filters.owner?.unassigned === true) conditions.push('matched.assigned_user_id IS NULL');
  if (filters.stageKey !== undefined) conditions.push(`matched.stage_key = ${bind(filters.stageKey)}`);
  if (filters.activeSince !== undefined) conditions.push(`matched.last_activity_at >= ${bind(filters.activeSince)}`);
  if (filters.activeUntil !== undefined) conditions.push(`matched.last_activity_at <= ${bind(filters.activeUntil)}`);
  if (filters.sequenceStatus === 'active' || filters.sequenceStatus === 'stopped') conditions.push('false');
  if (filters.holdReasonCode !== undefined) {
    conditions.push(`EXISTS (SELECT 1 FROM active_holds h
                              WHERE h.workspace_id = matched.workspace_id AND h.scope_kind = 'firm'
                                AND h.scope_key = matched.id::text AND h.released_at IS NULL
                                AND h.reason_code = ${bind(filters.holdReasonCode)})`);
  }
  if (filters.routeEligibility !== undefined) {
    const eligibility = bind(filters.routeEligibility);
    conditions.push(`(EXISTS (SELECT 1 FROM phone_routes pr
                               WHERE pr.workspace_id = matched.workspace_id AND pr.firm_id = matched.id
                                 AND pr.eligibility = ${eligibility})
                      OR EXISTS (SELECT 1 FROM email_addresses ea
                                  WHERE ea.workspace_id = matched.workspace_id AND ea.firm_id = matched.id
                                    AND ea.eligibility = ${eligibility}))`);
  }
  if (hasTerm) conditions.push('(m_name OR m_domain OR m_locality OR m_alias OR m_address OR m_contact OR m_email OR m_phone)');

  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const bounded = bind(limit + 1);

  const { rows } = await context.db.query<SearchRow>(
    `SELECT * FROM (
       SELECT f.*, (${wide}) AS wide,
              o.status AS opportunity_status, o.control_mode, o.opened_at, ps.key AS stage_key,
              GREATEST(
                f.updated_at,
                COALESCE((SELECT max(e.occurred_at) FROM opportunity_stage_events e
                           WHERE e.workspace_id = f.workspace_id AND e.firm_id = f.id), f.updated_at),
                COALESCE((SELECT max(v.retrieved_at) FROM evidence_items v
                           WHERE v.workspace_id = f.workspace_id AND v.firm_id = f.id), f.updated_at)
              ) AS last_activity_at,
              ${flags.join(',\n              ')}
         FROM firms f
         LEFT JOIN opportunities o
                ON o.workspace_id = f.workspace_id AND o.firm_id = f.id AND o.status = 'open'
         LEFT JOIN pipeline_stages ps ON ps.workspace_id = o.workspace_id AND ps.id = o.stage_id
        WHERE f.workspace_id = ${workspace} AND f.status = 'active'
     ) matched
     ${where}
     ORDER BY matched.name, matched.id
     LIMIT ${bounded}`,
    values,
  );

  const truncated = rows.length > limit;
  const hits = rows.slice(0, limit).map(row => ({
    visibility: decideFirmRead(context, row),
    firm: firmIdentityDtoOf(row, {
      stageKey: row.stage_key,
      status: row.opportunity_status,
      controlMode: row.control_mode,
      openedAt: row.opened_at === null ? null : row.opened_at.toISOString(),
    }),
    matchedOn: matchedOn(row),
    lastActivityAt: row.last_activity_at.toISOString(),
  }));

  return accept({ hits, truncated });
}
