import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from './audit.ts';
import type { ContactDto, FirmDetailDto, FirmIdentityDto, FirmReadDto, RouteDto } from './dto.ts';
import { searchFirms, type SearchFilters, type SearchHit } from './search.ts';
import { accept, type CrmResult } from './types.ts';

/**
 * CRM export (specification 5.2, 7.2, 14.1, Appendix F).
 *
 * "Authorized exports are typed, redacted, audited DTOs."
 *
 * **Typed and redacted** is `FirmReadDto`, the same discriminated union a single
 * firm read returns. A firm the caller is assigned, or any firm for an admin, is a
 * `FirmDetailDto`; everybody else's is a `FirmIdentityDto`, which has no field a
 * contact, an address or a route could be in. A colleague's firm is not *removed*
 * from the export — an export of "every firm at this stage" that silently dropped
 * half the pipeline would be worse than useless — it is exported at the width the
 * matrix gives.
 *
 * **Audited** is one `export.firms` event per export, with the row counts and
 * without the search term. The term may be a prospect's email address, and 5.2 says
 * audit records exclude unnecessary content; what an auditor needs is that this
 * person exported this many rows at this instant, and `termPresent` tells them
 * whether it was a targeted export or the whole book.
 *
 * Selection is `searchFirms`, unchanged, so an export is a search somebody decided
 * to keep: the same filters, the same term, and — the part that matters — the same
 * rule about which fields a term is matched against. An export that matched on
 * fields the search would not have would be a way to ask the redacted question
 * twice.
 *
 * ## Why there is no CSV
 *
 * A flat file has one set of columns. Appendix F gives firms two visibility classes,
 * and a CSV of both would need `address_line` and `contact_name` columns that are
 * populated for some rows and blank for others — which is exactly the "one type with
 * a filter" shape the two DTOs exist to avoid, re-created in the output format. A
 * client that wants a spreadsheet renders one from the rows it was given and knows,
 * per row, which class it is holding.
 */

export interface ExportInput {
  readonly term?: string;
  readonly filters?: SearchFilters;
  readonly limit?: number;
}

export interface FirmExport {
  readonly rows: readonly FirmReadDto[];
  /** What the export was asked for, echoed so the file can say what it is. */
  readonly selection: { readonly termPresent: boolean; readonly filters: readonly string[] };
  readonly exportedAt: string;
  readonly truncated: boolean;
}

interface ContactRowShape {
  readonly id: string;
  readonly firm_id: string;
  readonly full_name: string;
  readonly title: string | null;
  readonly status: 'active' | 'inactive' | 'merged';
  readonly is_primary: boolean;
  readonly [column: string]: unknown;
}

interface RouteRowShape {
  readonly id: string;
  readonly firm_id: string;
  readonly contact_id: string | null;
  readonly value: string;
  readonly eligibility: RouteDto['eligibility'];
  readonly version: number;
  readonly [column: string]: unknown;
}

interface AliasRowShape {
  readonly firm_id: string;
  readonly alias_kind: string;
  readonly alias_value: string;
  readonly [column: string]: unknown;
}

interface FirmDetailColumns {
  readonly id: string;
  readonly address_line: string | null;
  readonly postal_code: string | null;
  readonly country_code: string;
  readonly time_zone_confidence: 'high' | 'medium' | null;
  readonly time_zone_source: string | null;
  readonly [column: string]: unknown;
}

function groupBy<Row extends { readonly firm_id: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = grouped.get(row.firm_id);
    if (existing === undefined) grouped.set(row.firm_id, [row]);
    else existing.push(row);
  }
  return grouped;
}

/**
 * The detail half of every wide row, in four queries rather than four per firm.
 *
 * `readFirmForActor` is the right shape for one firm and the wrong shape for five
 * hundred: it would issue two thousand statements and — because an admin reading a
 * firm they do not own is an audited read — write five hundred audit events for what
 * the specification calls one export.
 */
async function detailsFor(
  context: RepositoryContext,
  firmIds: readonly string[],
): Promise<{
  readonly firms: Map<string, FirmDetailColumns>;
  readonly contacts: Map<string, ContactRowShape[]>;
  readonly phones: Map<string, RouteRowShape[]>;
  readonly emails: Map<string, RouteRowShape[]>;
  readonly aliases: Map<string, AliasRowShape[]>;
}> {
  const workspace = context.scope.workspaceId;
  const empty = {
    firms: new Map<string, FirmDetailColumns>(),
    contacts: new Map<string, ContactRowShape[]>(),
    phones: new Map<string, RouteRowShape[]>(),
    emails: new Map<string, RouteRowShape[]>(),
    aliases: new Map<string, AliasRowShape[]>(),
  };
  if (firmIds.length === 0) return empty;

  const firms = await context.db.query<FirmDetailColumns>(
    `SELECT id::text AS id, address_line, postal_code, country_code, time_zone_confidence, time_zone_source
       FROM firms WHERE workspace_id = $1 AND id = ANY ($2::uuid[])`,
    [workspace, firmIds],
  );
  const contacts = await context.db.query<ContactRowShape>(
    `SELECT id::text AS id, firm_id::text AS firm_id, full_name, title, status, is_primary
       FROM contacts
      WHERE workspace_id = $1 AND firm_id = ANY ($2::uuid[]) AND status <> 'merged'
      ORDER BY is_primary DESC, full_name`,
    [workspace, firmIds],
  );
  const phones = await context.db.query<RouteRowShape>(
    `SELECT id::text AS id, firm_id::text AS firm_id, contact_id::text AS contact_id,
            e164 AS value, eligibility, version
       FROM phone_routes WHERE workspace_id = $1 AND firm_id = ANY ($2::uuid[]) ORDER BY e164`,
    [workspace, firmIds],
  );
  const emails = await context.db.query<RouteRowShape>(
    `SELECT id::text AS id, firm_id::text AS firm_id, contact_id::text AS contact_id,
            address AS value, eligibility, version
       FROM email_addresses WHERE workspace_id = $1 AND firm_id = ANY ($2::uuid[]) ORDER BY address`,
    [workspace, firmIds],
  );
  const aliases = await context.db.query<AliasRowShape>(
    `SELECT firm_id::text AS firm_id, alias_kind, alias_value
       FROM record_aliases
      WHERE workspace_id = $1 AND firm_id = ANY ($2::uuid[]) AND record_kind = 'firm'
      ORDER BY alias_kind, alias_value`,
    [workspace, firmIds],
  );

  return {
    firms: new Map(firms.rows.map(row => [row.id, row])),
    contacts: groupBy(contacts.rows),
    phones: groupBy(phones.rows),
    emails: groupBy(emails.rows),
    aliases: groupBy(aliases.rows),
  };
}

function contactDto(row: ContactRowShape): ContactDto {
  return {
    id: row.id,
    fullName: row.full_name,
    title: row.title,
    status: row.status,
    isPrimary: row.is_primary,
  };
}

function routeDto(row: RouteRowShape): RouteDto {
  return {
    id: row.id,
    contactId: row.contact_id,
    value: row.value,
    eligibility: row.eligibility,
    version: Number(row.version),
  };
}

function detailDto(
  identity: FirmIdentityDto,
  columns: FirmDetailColumns | undefined,
  details: Awaited<ReturnType<typeof detailsFor>>,
): FirmDetailDto {
  return {
    ...identity,
    addressLine: columns?.address_line ?? null,
    postalCode: columns?.postal_code ?? null,
    countryCode: columns?.country_code ?? 'US',
    timeZoneConfidence: columns?.time_zone_confidence ?? null,
    timeZoneSource: columns?.time_zone_source ?? null,
    contacts: (details.contacts.get(identity.id) ?? []).map(contactDto),
    phoneRoutes: (details.phones.get(identity.id) ?? []).map(routeDto),
    emailRoutes: (details.emails.get(identity.id) ?? []).map(routeDto),
    aliases: (details.aliases.get(identity.id) ?? []).map(alias => ({
      aliasKind: alias.alias_kind,
      aliasValue: alias.alias_value,
    })),
  };
}

export async function exportFirms(context: RepositoryContext, input: ExportInput): Promise<CrmResult<FirmExport>> {
  const selected = await searchFirms(context, {
    ...(input.term === undefined ? {} : { term: input.term }),
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  // A refused export is not an export: nothing left the system, so nothing is audited.
  if (!selected.ok) return selected;

  const wide = selected.value.hits.filter((hit: SearchHit) => hit.visibility === 'assigned_or_admin');
  const details = await detailsFor(
    context,
    wide.map(hit => hit.firm.id),
  );

  const rows: FirmReadDto[] = selected.value.hits.map(hit =>
    hit.visibility === 'assigned_or_admin'
      ? { visibility: 'assigned_or_admin', firm: detailDto(hit.firm, details.firms.get(hit.firm.id), details) }
      : { visibility: 'any_active_member', firm: hit.firm },
  );

  const filters = Object.keys(input.filters ?? {}).sort();
  const termPresent = (input.term ?? '').trim().length > 0;

  // 5.2: "Admin reads of message bodies, drafts, mailbox diagnostics, and exports
  // create access audit events." One event, in the caller's transaction, naming what
  // left and not what was in it.
  await recordCrmAuditEvent(context, {
    action: 'export.firms',
    subjectKind: 'workspace',
    subjectId: context.scope.workspaceId,
    detail: {
      rowCount: rows.length,
      detailRowCount: wide.length,
      truncated: selected.value.truncated,
      termPresent,
      filters,
    },
  });

  return accept({
    rows,
    selection: { termPresent, filters },
    exportedAt: new Date().toISOString(),
    truncated: selected.value.truncated,
  });
}
