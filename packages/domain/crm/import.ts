import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideAdminOnly } from './authorization.ts';
import { createContact } from './contacts.ts';
import { createFirm } from './firms.ts';
import { addEmailRoute, addPhoneRoute } from './routes.ts';
import { accept, refuse, type CrmResult } from './types.ts';

/**
 * Admin CSV import (specification 7.2, Appendix G 38).
 *
 * "Admin-only CSV import validates into a preview and commits through ordinary
 * business commands." Appendix G 38 adds the four cases: "CSV import with
 * duplicates, cross-workspace IDs, invalid routes, and partial failures produces a
 * preview and atomic per-row commands without leakage."
 *
 * The shape follows from those two sentences.
 *
 * **Two phases, and the first one writes nothing.** `previewCsvImport` parses,
 * normalizes and checks; it takes no lock and inserts no row, so an admin may run it
 * as often as they like on a file they are still fixing.
 *
 * **The commit goes through the ordinary commands.** `commitImportRow` calls
 * `createFirm`, `createContact`, `addEmailRoute` and `addPhoneRoute` — the same
 * functions the API's own routes call, with the same authorization, the same audit
 * events and the same route-eligibility policy. An import that wrote rows directly
 * would be a second CRM with none of the rules, and the first thing it would lose is
 * that eligibility is the policy's decision and never the caller's: a spreadsheet
 * column cannot make a phone number `usable`.
 *
 * **One row is one command, and one command is one transaction.** The API wraps each
 * `commitImportRow` in `runCommand`, so each row gets its own receipt, its own
 * payload hash and its own transaction. A row whose contact fails takes its firm back
 * with it, and the rows either side of it still commit. That is "atomic per row" and
 * "partial failures" in the same sentence.
 *
 * **Nothing about the workspace next door.** Every lookup is scoped, so an external
 * id that names a firm in another workspace is simply not found here, and the preview
 * says `create` in the same words it uses for an id that exists nowhere at all. There
 * is no code path that could say anything else, because there is no query that could
 * see it.
 */

/** The columns a file may have, in the order `IMPORT_COLUMNS.join(',')` writes them. */
export const IMPORT_COLUMNS = [
  'firm_name',
  'website',
  'address_line',
  'locality',
  'region_code',
  'postal_code',
  'external_id',
  'owner_user_id',
  'contact_name',
  'contact_title',
  'contact_email',
  'contact_phone',
] as const;
export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const IMPORT_ISSUE_CODES = [
  'firm_name_missing',
  'website_invalid',
  'region_code_invalid',
  'postal_code_invalid',
  'email_invalid',
  'phone_invalid',
  'contact_name_missing',
  'owner_unknown',
  'duplicate_in_file',
  'duplicate_in_workspace',
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

export interface ImportIssue {
  readonly column: ImportColumn;
  readonly code: ImportIssueCode;
}

export type CsvRefusal = 'csv_empty' | 'csv_column_unknown' | 'csv_row_width' | 'csv_too_many_rows';

export interface CsvRow {
  /** The line number a person sees in their spreadsheet. The header is 1. */
  readonly number: number;
  readonly fields: readonly string[];
}

export interface ParsedCsv {
  readonly header: readonly string[];
  readonly rows: readonly CsvRow[];
}

/** One file may not be unbounded: the preview is held in memory and answered at once. */
export const MAX_IMPORT_ROWS = 2_000;

/**
 * RFC 4180, as far as a spreadsheet export goes: quoted fields, `""` for a quote
 * inside one, commas and newlines inside quotes, and either line ending.
 *
 * Written rather than depended on because it is forty lines, the failure modes of a
 * CSV library are a supply-chain surface for a file an administrator uploads, and
 * the rows a spreadsheet produces are the only rows this ever sees.
 */
export function parseCsv(source: string): { ok: true; value: ParsedCsv } | { ok: false; reason: CsvRefusal } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  let sawAnything = false;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    sawAnything = true;
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      endField();
    } else if (character === '\n') {
      endRecord();
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field.length > 0 || record.length > 0) endRecord();
  if (!sawAnything || records.length === 0) return { ok: false, reason: 'csv_empty' };

  const header = (records[0] ?? []).map(name => name.trim().toLowerCase());
  if (header.length === 0 || header.every(name => name.length === 0)) return { ok: false, reason: 'csv_empty' };
  const known = new Set<string>(IMPORT_COLUMNS);
  if (header.some(name => !known.has(name))) return { ok: false, reason: 'csv_column_unknown' };

  const rows = records.slice(1).filter(fields => fields.some(value => value.trim().length > 0));
  if (rows.length > MAX_IMPORT_ROWS) return { ok: false, reason: 'csv_too_many_rows' };
  if (rows.some(fields => fields.length !== header.length)) return { ok: false, reason: 'csv_row_width' };

  return {
    ok: true,
    value: { header, rows: rows.map((fields, offset) => ({ number: offset + 2, fields })) },
  };
}

export interface ImportFirmDraft {
  readonly name: string;
  readonly website: string | null;
  readonly addressLine: string | null;
  readonly locality: string | null;
  readonly regionCode: string | null;
  readonly postalCode: string | null;
  readonly externalId: string | null;
  readonly ownerUserId: string | null;
}

export interface ImportContactDraft {
  readonly fullName: string;
  readonly title: string | null;
}

export interface ImportRouteDraft {
  readonly kind: 'email' | 'phone';
  /** Already canonical: lower-cased for an address, E.164 for a number. */
  readonly value: string;
}

export type ImportRowOutcome = 'create' | 'duplicate' | 'invalid';

export interface ImportPreviewRow {
  readonly rowNumber: number;
  readonly outcome: ImportRowOutcome;
  readonly issues: readonly ImportIssue[];
  readonly firm: ImportFirmDraft;
  readonly contact: ImportContactDraft | null;
  readonly routes: readonly ImportRouteDraft[];
}

export interface ImportPreview {
  readonly rows: readonly ImportPreviewRow[];
  readonly counts: Readonly<Record<ImportRowOutcome, number>>;
}

const REGION_CODE = /^[A-Z]{2}$/u;
const POSTAL_CODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;

/**
 * A number as a spreadsheet holds it, as E.164, or null.
 *
 * Ten digits are assumed to be North American, because `calling_identities` and the
 * fictional 555-01XX test block are, and because a ten-digit string with no country
 * code is otherwise unresolvable. Eleven digits starting with 1, and anything already
 * carrying a `+`, are taken as written. Everything else is `phone_invalid` rather
 * than a guess: a wrong number is dialed at a stranger.
 */
export function canonicalE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const digits = trimmed.replaceAll(/[^0-9]/gu, '');
  const candidate = trimmed.startsWith('+')
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith('1')
        ? `+${digits}`
        : null;
  return candidate !== null && E164.test(candidate) ? candidate : null;
}

function cell(header: readonly string[], fields: readonly string[], column: ImportColumn): string {
  const index = header.indexOf(column);
  return index === -1 ? '' : (fields[index] ?? '').trim();
}

function orNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

/** The key two rows are the same firm by: the canonical name, case-folded. */
function duplicateKey(draft: ImportFirmDraft): string {
  return draft.name.toLowerCase().replaceAll(/\s+/gu, ' ');
}

interface RowDraft {
  readonly rowNumber: number;
  readonly firm: ImportFirmDraft;
  readonly contact: ImportContactDraft | null;
  readonly routes: readonly ImportRouteDraft[];
  readonly issues: ImportIssue[];
}

function draftOf(header: readonly string[], row: CsvRow): RowDraft {
  const issues: ImportIssue[] = [];
  const at = (column: ImportColumn): string => cell(header, row.fields, column);

  const name = at('firm_name').replaceAll(/\s+/gu, ' ');
  if (name.length === 0) issues.push({ column: 'firm_name', code: 'firm_name_missing' });

  const website = orNull(at('website'));
  if (website !== null && !/^https?:\/\/[^\s]+\.[^\s]+$/u.test(website)) {
    issues.push({ column: 'website', code: 'website_invalid' });
  }
  const regionCode = orNull(at('region_code').toUpperCase());
  if (regionCode !== null && !REGION_CODE.test(regionCode)) {
    issues.push({ column: 'region_code', code: 'region_code_invalid' });
  }
  const postalCode = orNull(at('postal_code'));
  if (postalCode !== null && !POSTAL_CODE.test(postalCode)) {
    issues.push({ column: 'postal_code', code: 'postal_code_invalid' });
  }

  const contactName = at('contact_name');
  const contactTitle = orNull(at('contact_title'));
  const rawEmail = at('contact_email').toLowerCase();
  const rawPhone = at('contact_phone');

  const routes: ImportRouteDraft[] = [];
  if (rawEmail.length > 0) {
    if (EMAIL.test(rawEmail) && rawEmail.length <= 320) routes.push({ kind: 'email', value: rawEmail });
    else issues.push({ column: 'contact_email', code: 'email_invalid' });
  }
  if (rawPhone.length > 0) {
    const canonical = canonicalE164(rawPhone);
    if (canonical !== null) routes.push({ kind: 'phone', value: canonical });
    else issues.push({ column: 'contact_phone', code: 'phone_invalid' });
  }
  // A title or a route with nobody to attach them to is a row somebody mis-filled.
  if (contactName.length === 0 && (contactTitle !== null || routes.length > 0)) {
    issues.push({ column: 'contact_name', code: 'contact_name_missing' });
  }

  return {
    rowNumber: row.number,
    firm: {
      name,
      website,
      addressLine: orNull(at('address_line')),
      locality: orNull(at('locality')),
      regionCode,
      postalCode,
      externalId: orNull(at('external_id')),
      ownerUserId: orNull(at('owner_user_id')),
    },
    contact: contactName.length === 0 ? null : { fullName: contactName, title: contactTitle },
    routes,
    issues,
  };
}

/** Every member id in this workspace that the file named. Scoped, so nothing crosses. */
async function knownOwners(context: RepositoryContext, candidates: readonly string[]): Promise<ReadonlySet<string>> {
  const wanted = [...new Set(candidates)];
  if (wanted.length === 0) return new Set();
  // A malformed id is not a member either; the query is parameterized as text so a
  // value that is not a UUID is simply not found rather than raising 22P02.
  const { rows } = await context.db.query<{ user_id: string }>(
    `SELECT user_id::text AS user_id FROM workspace_memberships
      WHERE workspace_id = $1 AND status = 'active' AND user_id::text = ANY ($2::text[])`,
    [context.scope.workspaceId, wanted],
  );
  return new Set(rows.map(row => row.user_id));
}

/** Every already-present firm, by duplicate key and by external id. Scoped. */
async function existingFirms(
  context: RepositoryContext,
): Promise<{ readonly names: ReadonlySet<string>; readonly externalIds: ReadonlySet<string> }> {
  const names = await context.db.query<{ key: string }>(
    `SELECT lower(regexp_replace(name, '\\s+', ' ', 'g')) AS key
       FROM firms WHERE workspace_id = $1 AND status = 'active'`,
    [context.scope.workspaceId],
  );
  const aliases = await context.db.query<{ alias_value: string }>(
    `SELECT alias_value FROM record_aliases
      WHERE workspace_id = $1 AND alias_kind = 'external_id'`,
    [context.scope.workspaceId],
  );
  return {
    names: new Set(names.rows.map(row => row.key)),
    externalIds: new Set(aliases.rows.map(row => row.alias_value)),
  };
}

export async function previewCsvImport(
  context: RepositoryContext,
  input: { readonly csv: string },
): Promise<CrmResult<ImportPreview>> {
  // Before a byte is parsed: 5.2 makes import an administrator's command.
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);

  const parsed = parseCsv(input.csv);
  if (!parsed.ok) return refuse('invalid_input');

  const drafts = parsed.value.rows.map(row => draftOf(parsed.value.header, row));
  const owners = await knownOwners(
    context,
    drafts.map(draft => draft.firm.ownerUserId).filter((value): value is string => value !== null),
  );
  const existing = await existingFirms(context);

  const seenInFile = new Set<string>();
  const rows: ImportPreviewRow[] = [];
  for (const draft of drafts) {
    const issues = [...draft.issues];
    if (draft.firm.ownerUserId !== null && !owners.has(draft.firm.ownerUserId)) {
      issues.push({ column: 'owner_user_id', code: 'owner_unknown' });
    }

    const key = duplicateKey(draft.firm);
    const duplicateHere =
      key.length > 0 &&
      (existing.names.has(key) ||
        (draft.firm.externalId !== null && existing.externalIds.has(draft.firm.externalId)));
    const duplicateInFile = key.length > 0 && seenInFile.has(key);
    if (duplicateInFile) issues.push({ column: 'firm_name', code: 'duplicate_in_file' });
    else if (duplicateHere) issues.push({ column: 'firm_name', code: 'duplicate_in_workspace' });
    if (key.length > 0) seenInFile.add(key);

    // Invalid beats duplicate: a row that is both is shown the fault it can fix.
    const invalid = issues.some(
      issue => issue.code !== 'duplicate_in_file' && issue.code !== 'duplicate_in_workspace',
    );
    const outcome: ImportRowOutcome = invalid ? 'invalid' : duplicateInFile || duplicateHere ? 'duplicate' : 'create';

    rows.push({
      rowNumber: draft.rowNumber,
      outcome,
      issues,
      firm: draft.firm,
      contact: draft.contact,
      routes: draft.routes,
    });
  }

  return accept({
    rows,
    counts: {
      create: rows.filter(row => row.outcome === 'create').length,
      duplicate: rows.filter(row => row.outcome === 'duplicate').length,
      invalid: rows.filter(row => row.outcome === 'invalid').length,
    },
  });
}

export interface ImportRowCommitted {
  readonly rowNumber: number;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly routeIds: readonly string[];
}

/**
 * Commit one previewed row through the ordinary commands.
 *
 * The caller supplies the transaction — in the API that is `runCommand`, which
 * commits the receipt with the mutation — so every refusal below leaves the row's own
 * work rolled back and the rows either side of it untouched.
 *
 * The row is re-checked rather than trusted. A preview is a value a client holds and
 * may edit, so `outcome` is re-derived from the issues rather than believed, and the
 * routes are re-validated against the same patterns. The duplicate check is not
 * repeated here: the database's own uniqueness is what settles a race, and a firm
 * created between the preview and the commit is a refusal from `createFirm`.
 */
export async function commitImportRow(
  context: RepositoryContext,
  row: ImportPreviewRow,
): Promise<CrmResult<ImportRowCommitted>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refuse(permitted.reason);
  if (row.outcome !== 'create' || row.issues.length > 0) return refuse('invalid_input');
  if (row.firm.name.trim().length === 0) return refuse('invalid_input');
  for (const route of row.routes) {
    const valid = route.kind === 'email' ? EMAIL.test(route.value) : E164.test(route.value);
    if (!valid) return refuse('invalid_input');
  }

  const firm = await createFirm(context, {
    name: row.firm.name,
    ...(row.firm.website === null ? {} : { website: row.firm.website }),
    ...(row.firm.addressLine === null ? {} : { addressLine: row.firm.addressLine }),
    ...(row.firm.locality === null ? {} : { locality: row.firm.locality }),
    ...(row.firm.regionCode === null ? {} : { regionCode: row.firm.regionCode }),
    ...(row.firm.postalCode === null ? {} : { postalCode: row.firm.postalCode }),
    ...(row.firm.externalId === null ? {} : { externalId: row.firm.externalId }),
    ...(row.firm.ownerUserId === null ? {} : { assignedUserId: row.firm.ownerUserId }),
  });
  if (!firm.ok) return refuse(firm.reason);
  const firmId = firm.value.id;

  let contactId: string | null = null;
  if (row.contact !== null) {
    const contact = await createContact(context, {
      firmId,
      fullName: row.contact.fullName,
      ...(row.contact.title === null ? {} : { title: row.contact.title }),
      isPrimary: true,
    });
    if (!contact.ok) return refuse(contact.reason);
    contactId = contact.value.id;
  }

  const routeIds: string[] = [];
  for (const route of row.routes) {
    // `source: 'import'` is what section 7.2 asks a route to record about where it
    // came from, and it is why `decideRouteEligibility` leaves these as candidates:
    // a spreadsheet has neither technical validation nor association confidence.
    const added =
      route.kind === 'email'
        ? await addEmailRoute(context, {
            firmId,
            ...(contactId === null ? {} : { contactId }),
            address: route.value,
            source: 'import',
          })
        : await addPhoneRoute(context, {
            firmId,
            ...(contactId === null ? {} : { contactId }),
            e164: route.value,
            source: 'import',
          });
    if (!added.ok) return refuse(added.reason);
    routeIds.push(added.value.id);
  }

  return accept({ rowNumber: row.rowNumber, firmId, contactId, routeIds });
}
