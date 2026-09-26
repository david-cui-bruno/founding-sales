import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmRead, firmReadIsAudited, type FirmReadVisibility } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { listContacts } from './contacts.ts';
import { readFirm } from './firms.ts';
import { listFirmAliases } from './merges.ts';
import { readOpenOpportunity, listPipelineStages } from './pipeline.ts';
import { listRoutes } from './routes.ts';
import { accept, refuse, type CrmResult, type FirmRow } from './types.ts';

/**
 * Typed redacted DTOs for CRM reads (specification 14.1 and Appendix F).
 *
 * "No endpoint returns a generic activity row. Responses are typed and redacted for
 * the caller's visibility class."
 *
 * Appendix F's first row — firm identity, pipeline stage and dates, sequence status,
 * call outcomes without notes — is visible to any active member. Its second row —
 * message bodies, notes, callbacks, drafts — is the assigned salesperson's and the
 * admins'. So there are exactly two DTOs, and which one a caller gets is decided
 * from the scope and the firm's assignee, never from a flag in the request.
 *
 * The bodies, notes and callbacks of the second row do not exist yet; they belong to
 * later lanes. What exists now is the class that will carry them and the decision
 * that chooses it, so the lane that adds a note adds a field to `FirmDetailDto`
 * rather than deciding again who may see it.
 *
 * The redaction is by *construction*: `FirmIdentityDto` has no field a body could go
 * in, so a later change cannot leak one into the wide read by forgetting to delete
 * it. That is the reason these are two types rather than one type and a filter.
 */

/** Appendix F row 1. Every active member sees this much of every firm. */
export interface FirmIdentityDto {
  readonly id: string;
  readonly name: string;
  readonly website: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly status: 'active' | 'merged';
  /** Null when the firm is unassigned. A user id, never an email address. */
  readonly assignedUserId: string | null;
  /** The pipeline stage of the open opportunity, by key. Null when there is none. */
  readonly stageKey: string | null;
  readonly opportunityStatus: 'open' | 'won' | 'lost' | null;
  readonly controlMode: 'automated' | 'manual' | null;
  readonly openedAt: string | null;
  /** The firm's actual IANA zone, or null when it could not be established (9.2). */
  readonly timeZone: string | null;
  readonly timeZoneUnresolvedReason: string | null;
}

/** Appendix F row 2. Adds what belongs to the assignee and to admins. */
export interface FirmDetailDto extends FirmIdentityDto {
  readonly addressLine: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string;
  readonly timeZoneConfidence: 'high' | 'medium' | null;
  readonly timeZoneSource: string | null;
  readonly contacts: readonly ContactDto[];
  readonly phoneRoutes: readonly RouteDto[];
  readonly emailRoutes: readonly RouteDto[];
  readonly aliases: readonly { readonly aliasKind: string; readonly aliasValue: string }[];
}

export interface ContactDto {
  readonly id: string;
  readonly fullName: string;
  readonly title: string | null;
  readonly status: 'active' | 'inactive' | 'merged';
  readonly isPrimary: boolean;
}

export interface RouteDto {
  readonly id: string;
  readonly contactId: string | null;
  readonly value: string;
  readonly eligibility: 'candidate' | 'usable' | 'invalid' | 'retired';
  /** The number the card shows and `authorizeDial` compares against (9.1). */
  readonly version: number;
  /**
   * The route's technical validation (7.4), present only when the read asked for it —
   * the Firm page's second version. An older desktop parses this object
   * strictly and never asks.
   */
  readonly technicalValidation?: 'unknown' | 'passed' | 'failed';
}

export type FirmReadDto =
  | { readonly visibility: 'any_active_member'; readonly firm: FirmIdentityDto }
  | { readonly visibility: 'assigned_or_admin'; readonly firm: FirmDetailDto };

/**
 * Appendix F row 1, from a firm row and its open opportunity.
 *
 * Exported because CRM search and CRM export build the same narrow DTO from rows
 * they selected themselves, and a second copy of this mapping is a second place for
 * a later field to be added to only one of them.
 */
export function firmIdentityDtoOf(
  firm: FirmRow,
  opportunity: { stageKey: string | null; status: 'open' | 'won' | 'lost' | null; controlMode: 'automated' | 'manual' | null; openedAt: string | null },
): FirmIdentityDto {
  return {
    id: firm.id,
    name: firm.name,
    website: firm.website,
    locality: firm.locality,
    regionCode: firm.region_code,
    status: firm.status,
    assignedUserId: firm.assigned_user_id,
    stageKey: opportunity.stageKey,
    opportunityStatus: opportunity.status,
    controlMode: opportunity.controlMode,
    openedAt: opportunity.openedAt,
    timeZone: firm.time_zone,
    timeZoneUnresolvedReason: firm.time_zone_unresolved_reason,
  };
}

/**
 * Read one firm at whatever visibility the caller has, auditing the read when
 * Appendix F says to.
 *
 * It never returns "the full row minus some fields". The narrow case builds the
 * narrow type and never loads contacts or routes at all, so a read a salesperson is
 * not entitled to does not happen and then get filtered.
 */
export async function readFirmForActor(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    /** Put each route's `technicalValidation` on it. Absent is the first shape exactly. */
    readonly routeValidation?: boolean | undefined;
  },
): Promise<CrmResult<FirmReadDto>> {
  const firm = await readFirm(context, input.firmId);
  if (firm === null) return refuse('firm_unknown');

  const open = await readOpenOpportunity(context, firm.id);
  const stages = await listPipelineStages(context);
  const stageKey = open === null ? null : (stages.find(stage => stage.id === open.stage_id)?.key ?? null);
  const openedAtValue = open?.['opened_at'];
  const summary = {
    stageKey,
    status: open === null ? null : open.status,
    controlMode: open === null ? null : open.control_mode,
    openedAt: openedAtValue instanceof Date ? openedAtValue.toISOString() : null,
  };

  const visibility: FirmReadVisibility = decideFirmRead(context, firm);
  if (visibility === 'any_active_member') {
    return accept({ visibility, firm: firmIdentityDtoOf(firm, summary) });
  }

  if (firmReadIsAudited(context, firm)) {
    await recordCrmAuditEvent(context, {
      action: 'read.firm_detail',
      subjectKind: 'firm',
      subjectId: firm.id,
      detail: { visibility },
    });
  }

  // Serially, not in a `Promise.all`: `context.db` may be one backend connection
  // inside a transaction, and node-postgres warns (and will later fail) when a second
  // query is issued on a client that is already executing one.
  const contacts = await listContacts(context, firm.id);
  const phoneRoutes = await listRoutes(context, 'phone', firm.id);
  const emailRoutes = await listRoutes(context, 'email', firm.id);
  const aliases = await listFirmAliases(context, firm.id);

  return accept({
    visibility,
    firm: {
      ...firmIdentityDtoOf(firm, summary),
      addressLine: firm.address_line,
      postalCode: firm.postal_code,
      countryCode: firm.country_code,
      timeZoneConfidence: firm.time_zone_confidence,
      timeZoneSource: firm.time_zone_source,
      contacts: contacts.map(contact => ({
        id: contact.id,
        fullName: contact.full_name,
        title: contact.title,
        status: contact.status,
        isPrimary: contact.is_primary,
      })),
      phoneRoutes: phoneRoutes.map(row => routeDto(row, input.routeValidation === true)),
      emailRoutes: emailRoutes.map(row => routeDto(row, input.routeValidation === true)),
      aliases,
    },
  });
}

function routeDto(row: Readonly<Record<string, unknown>>, withValidation = false): RouteDto {
  return {
    id: String(row['id']),
    contactId: row['contact_id'] === null ? null : String(row['contact_id']),
    value: String(row['value'] ?? ''),
    eligibility: row['eligibility'] as RouteDto['eligibility'],
    version: Number(row['version']),
    ...(withValidation ? { technicalValidation: row['technical_validation'] as NonNullable<RouteDto['technicalValidation']> } : {}),
  };
}

/** Every firm a caller may see, at identity visibility. The wide read is per firm. */
export async function listFirmsForActor(
  context: RepositoryContext,
  options: { readonly limit?: number } = {},
): Promise<readonly FirmIdentityDto[]> {
  const { rows } = await context.db.query<
    FirmRow & { stage_key: string | null; opportunity_status: 'open' | 'won' | 'lost' | null; control_mode: 'automated' | 'manual' | null; opened_at: Date | null }
  >(
    `SELECT f.*, s.key AS stage_key, o.status AS opportunity_status, o.control_mode, o.opened_at
       FROM firms f
       LEFT JOIN opportunities o ON o.workspace_id = f.workspace_id AND o.firm_id = f.id AND o.status = 'open'
       LEFT JOIN pipeline_stages s ON s.workspace_id = o.workspace_id AND s.id = o.stage_id
      WHERE f.workspace_id = $1 AND f.status = 'active'
      ORDER BY f.name, f.id
      LIMIT $2`,
    [context.scope.workspaceId, Math.trunc(options.limit ?? 200)],
  );
  return rows.map(row =>
    firmIdentityDtoOf(row, {
      stageKey: row.stage_key,
      status: row.opportunity_status,
      controlMode: row.control_mode,
      openedAt: row.opened_at === null ? null : row.opened_at.toISOString(),
    }),
  );
}
