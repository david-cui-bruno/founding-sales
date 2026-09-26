import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isKnownTimeZone } from '../src/rules/localClock.ts';
import { decideAdminOnly } from './authorization.ts';
import { createContact } from './contacts.ts';
import { createFirm, resolveZoneForFirm } from './firms.ts';
import { addEmailRoute, addPhoneRoute } from './routes.ts';
import { actorUserId, type RouteSource } from './types.ts';
import {
  type CrmRefusalCode,
  IMPORT_COLUMNS,
  type ImportColumn,
  type ImportFileRefusal,
  type ImportIssueCode,
} from '@fss/contracts';

/**
 * Admin CSV import (specification 7.2, Appendix G 38), and the Add firm form that is one
 * row of it (audit item G02).
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
 * **One row is one contact**. A spreadsheet of prospects has a line per
 * person, with the firm's columns repeated on each of that firm's lines. So a row is
 * matched to a firm — one already in the workspace, by its external id, then its
 * website's domain, then its name; or one an earlier row of the file creates — and a
 * matched row adds its contact to that firm (`attach`) rather than being refused as a
 * second copy of it. A row is a duplicate only when it adds nothing: its contact is
 * already at that firm, by email or, without an email, by name; or it names only a firm
 * that is already there. `docs/decisions/g84-founder-capture-postures-and-refresh.md`
 * has the rules and what was rejected.
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
 * payload hash and its own transaction. Inside it the row's own work runs in a
 * savepoint: a row whose contact is refused takes its firm back with it
 * while the refusal's receipt still commits, and the rows either side of it are
 * untouched. That is "atomic per row" and "partial failures" in the same sentence.
 * Before the savepoint a refusal part-way through a row committed the part before it
 * with the refused receipt, and a refusal that came from a database error left the
 * transaction unable to write the receipt at all.
 *
 * **Nothing about the workspace next door.** Every lookup is scoped, so an external
 * id that names a firm in another workspace is simply not found here, and the preview
 * says `create` in the same words it uses for an id that exists nowhere at all. There
 * is no code path that could say anything else, because there is no query that could
 * see it.
 */

export interface ImportIssue {
  readonly column: ImportColumn;
  readonly code: ImportIssueCode;
}

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
 * Every refusal a capture may answer with: the CRM's own codes, a whole file's, and a
 * row's issue codes, which is what a commit of a row the preview found at fault says.
 */
export type ImportRefusal = CrmRefusalCode | ImportFileRefusal | ImportIssueCode;

/**
 * The outcome of a preview or a commit. A refusal names where it is: the column a row's
 * fault is in, or the header and the line a file's fault is on, so the person reading it
 * knows which cell to fix. `issues` is every fault a refused Add firm found, and
 * `firmId` the firm a duplicate matched.
 */
export type ImportResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly reason: ImportRefusal;
      readonly column: string | null;
      readonly rowNumber: number | null;
      readonly issues?: readonly ImportIssue[];
      readonly firmId?: string;
    };

function accepted<T>(value: T): ImportResult<T> {
  return { ok: true, value };
}

function refused<T>(
  reason: ImportRefusal,
  where: {
    readonly column?: string | null;
    readonly rowNumber?: number | null;
    readonly issues?: readonly ImportIssue[];
    readonly firmId?: string;
  } = {},
): ImportResult<T> {
  return {
    ok: false,
    reason,
    column: where.column ?? null,
    rowNumber: where.rowNumber ?? null,
    ...(where.issues === undefined ? {} : { issues: where.issues }),
    ...(where.firmId === undefined ? {} : { firmId: where.firmId }),
  };
}

/**
 * A header cell as a column name: trimmed, lower-cased, and a space or a hyphen read as
 * an underscore, so `Firm name`, `firm-name` and `FIRM_NAME` are all `firm_name`.
 */
export function headerColumn(cell: string): string {
  return cell.trim().toLowerCase().replaceAll(/[\s-]+/gu, '_');
}

/**
 * RFC 4180, as far as a spreadsheet export goes: quoted fields, `""` for a quote
 * inside one, commas and newlines inside quotes, and either line ending. A leading
 * byte-order mark, which Excel writes at the start of every "CSV UTF-8" file, is not
 * part of the first column's name.
 *
 * Written rather than depended on because it is forty lines, the failure modes of a
 * CSV library are a supply-chain surface for a file an administrator uploads, and
 * the rows a spreadsheet produces are the only rows this ever sees.
 */
export function parseCsv(
  source: string,
):
  | { ok: true; value: ParsedCsv }
  | { ok: false; reason: ImportFileRefusal; column: string | null; rowNumber: number | null } {
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  const refusal = (reason: ImportFileRefusal, column: string | null = null, rowNumber: number | null = null) =>
    ({ ok: false, reason, column, rowNumber }) as const;
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

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    sawAnything = true;
    if (quoted) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
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
  if (!sawAnything || records.length === 0) return refusal('csv_empty');

  const header = (records[0] ?? []).map(headerColumn);
  if (header.length === 0 || header.every(name => name.length === 0)) return refusal('csv_empty');
  const known = new Set<string>(IMPORT_COLUMNS);
  const unknown = header.find(name => !known.has(name));
  if (unknown !== undefined) return refusal('csv_column_unknown', (records[0] ?? [])[header.indexOf(unknown)]?.trim() ?? unknown);
  const repeated = header.find((name, index) => header.indexOf(name) !== index);
  if (repeated !== undefined) return refusal('csv_column_repeated', repeated);

  // Line numbers are counted before blank lines are dropped, so a refusal names the
  // line the spreadsheet shows.
  const rows = records
    .map((fields, offset) => ({ number: offset + 1, fields }))
    .slice(1)
    .filter(row => row.fields.some(value => value.trim().length > 0));
  if (rows.length > MAX_IMPORT_ROWS) return refusal('csv_too_many_rows');
  const ragged = rows.find(row => row.fields.length !== header.length);
  if (ragged !== undefined) return refusal('csv_row_width', null, ragged.number);

  return { ok: true, value: { header, rows } };
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
  /** An IANA zone the row recorded, or null for "work it out from the state and ZIP". */
  readonly timeZone: string | null;
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

export type ImportRowOutcome = 'create' | 'attach' | 'duplicate' | 'invalid';

/**
 * The firm a row belongs to when it is not a new one. `existing` is in the workspace
 * now; `in_file` is the firm an earlier row of the same file creates.
 */
export type ImportFirmMatch =
  | {
      readonly kind: 'existing';
      readonly firmId: string;
      readonly firmName: string;
      readonly matchedOn: 'external_id' | 'domain' | 'name';
    }
  | { readonly kind: 'in_file'; readonly rowNumber: number; readonly matchedOn: 'domain' | 'name' };

export interface ImportPreviewRow {
  readonly rowNumber: number;
  readonly outcome: ImportRowOutcome;
  readonly issues: readonly ImportIssue[];
  readonly firm: ImportFirmDraft;
  readonly contact: ImportContactDraft | null;
  readonly routes: readonly ImportRouteDraft[];
  readonly match: ImportFirmMatch | null;
}

export interface ImportPreview {
  readonly rows: readonly ImportPreviewRow[];
  readonly counts: Readonly<Record<ImportRowOutcome, number>>;
}

const REGION_CODE = /^[A-Z]{2}$/u;
const POSTAL_CODE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const E164 = /^\+[1-9][0-9]{7,14}$/u;
const IANA_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){1,2}$/u;

/** The database's own bounds (migration 0004), so a long cell is an issue and never a 500. */
const MAX_LENGTH: Readonly<Partial<Record<ImportColumn, number>>> = Object.freeze({
  firm_name: 300,
  address_line: 300,
  locality: 120,
  external_id: 320,
  contact_name: 200,
  contact_title: 200,
});

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

/**
 * A website as a person types it — `https://acme.example`, `acme.example` or
 * `www.acme.example/about` — as the URL the firm row stores, or `invalid`, or null
 * for a blank cell. A bare domain is given `https://`; the scheme is lower-cased,
 * because the row's CHECK reads it case-sensitively.
 */
export function canonicalWebsite(raw: string): string | null | 'invalid' {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (/\s/u.test(trimmed)) return 'invalid';
  const scheme = /^(https?):\/\//iu.exec(trimmed);
  const url = scheme === null ? `https://${trimmed}` : `${(scheme[1] ?? '').toLowerCase()}://${trimmed.slice(scheme[0].length)}`;
  if (url.length > 500) return 'invalid';
  try {
    const host = new URL(url).hostname;
    if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return 'invalid';
  } catch {
    return 'invalid';
  }
  return url;
}

/**
 * The domain two firms are the same firm by: the website's host, lower-cased, without a
 * leading `www.`. Null for no website, and for a stored value this cannot read.
 */
export function websiteDomain(website: string | null): string | null {
  if (website === null) return null;
  const url = canonicalWebsite(website);
  if (url === null || url === 'invalid') return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/** The key two firms are the same firm by name: trimmed, case-folded, spaces collapsed. */
export function firmNameKey(name: string): string {
  return name.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
}

/**
 * The key two contacts at one firm are the same person by: the email address when the
 * row has one, and the name when it does not.
 */
function contactKey(contact: ImportContactDraft | null, routes: readonly ImportRouteDraft[]): string | null {
  if (contact === null) return null;
  const email = routes.find(route => route.kind === 'email');
  return email !== undefined ? `email:${email.value}` : `name:${firmNameKey(contact.fullName)}`;
}

function contactColumn(key: string): ImportColumn {
  return key.startsWith('email:') ? 'contact_email' : 'contact_name';
}

function orNull(value: string): string | null {
  return value.length === 0 ? null : value;
}

interface RowDraft {
  readonly rowNumber: number;
  readonly firm: ImportFirmDraft;
  readonly contact: ImportContactDraft | null;
  readonly routes: readonly ImportRouteDraft[];
  readonly issues: ImportIssue[];
}

/**
 * One row's values, checked. `at` reads a column: a CSV cell, or a field of the Add firm
 * form under the column's name, so both are validated by this function and nothing else.
 */
function draftOf(rowNumber: number, at: (column: ImportColumn) => string): RowDraft {
  const issues: ImportIssue[] = [];
  const cell = (column: ImportColumn): string => at(column).trim();

  for (const [column, limit] of Object.entries(MAX_LENGTH) as [ImportColumn, number][]) {
    if (cell(column).length > limit) issues.push({ column, code: 'too_long' });
  }

  const name = cell('firm_name').replaceAll(/\s+/gu, ' ');
  if (name.length === 0) issues.push({ column: 'firm_name', code: 'firm_name_missing' });

  const website = canonicalWebsite(cell('website'));
  if (website === 'invalid') issues.push({ column: 'website', code: 'website_invalid' });

  const regionCode = orNull(cell('region_code').toUpperCase());
  if (regionCode !== null && !REGION_CODE.test(regionCode)) {
    issues.push({ column: 'region_code', code: 'region_code_invalid' });
  }
  const postalCode = orNull(cell('postal_code'));
  if (postalCode !== null && !POSTAL_CODE.test(postalCode)) {
    issues.push({ column: 'postal_code', code: 'postal_code_invalid' });
  }
  // A zone this runtime cannot place on a clock is worse than no zone: no zone holds
  // the firm's calls, a wrong one places them at the wrong hour (9.2).
  const timeZone = orNull(cell('time_zone'));
  if (timeZone !== null && !(IANA_ZONE.test(timeZone) && isKnownTimeZone(timeZone))) {
    issues.push({ column: 'time_zone', code: 'time_zone_invalid' });
  }

  const contactName = cell('contact_name');
  const contactTitle = orNull(cell('contact_title'));
  const rawEmail = cell('contact_email').toLowerCase();
  const rawPhone = cell('contact_phone');

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
  // A title, an address or a number with nobody to attach them to is a row somebody
  // mis-filled — said even when the address or the number is also wrong, so every fault
  // is in front of the person at once.
  if (contactName.length === 0 && (contactTitle !== null || rawEmail.length > 0 || rawPhone.length > 0)) {
    issues.push({ column: 'contact_name', code: 'contact_name_missing' });
  }

  return {
    rowNumber,
    firm: {
      name,
      website: website === 'invalid' ? null : website,
      addressLine: orNull(cell('address_line')),
      locality: orNull(cell('locality')),
      regionCode,
      postalCode,
      externalId: orNull(cell('external_id')),
      ownerUserId: orNull(cell('owner_user_id')),
      timeZone,
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

interface IndexedFirm {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
}

/** The workspace's active firms and their people, keyed the way a row is matched. Scoped. */
interface WorkspaceIndex {
  readonly byExternalId: ReadonlyMap<string, readonly IndexedFirm[]>;
  readonly byDomain: ReadonlyMap<string, readonly IndexedFirm[]>;
  readonly byName: ReadonlyMap<string, readonly IndexedFirm[]>;
  /** Firm id to the contact keys already there. */
  readonly contacts: ReadonlyMap<string, ReadonlySet<string>>;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

async function workspaceIndex(context: RepositoryContext): Promise<WorkspaceIndex> {
  const workspaceId = context.scope.workspaceId;
  const firms = await context.db.query<{ id: string; name: string; website: string | null }>(
    `SELECT id, name, website FROM firms WHERE workspace_id = $1 AND status = 'active'`,
    [workspaceId],
  );
  const byId = new Map<string, IndexedFirm>();
  const byExternalId = new Map<string, IndexedFirm[]>();
  const byDomain = new Map<string, IndexedFirm[]>();
  const byName = new Map<string, IndexedFirm[]>();
  for (const row of firms.rows) {
    const firm: IndexedFirm = { id: row.id, name: row.name, domain: websiteDomain(row.website) };
    byId.set(firm.id, firm);
    if (firm.domain !== null) pushTo(byDomain, firm.domain, firm);
    pushTo(byName, firmNameKey(firm.name), firm);
  }

  // A merge keeps the losing record's name, domain and external id as aliases of the
  // survivor (7.2), so a spreadsheet written before the merge still finds it.
  const aliases = await context.db.query<{ alias_kind: string; alias_value: string; firm_id: string }>(
    `SELECT a.alias_kind, a.alias_value, a.firm_id
       FROM record_aliases a
       JOIN firms f ON f.workspace_id = a.workspace_id AND f.id = a.firm_id
      WHERE a.workspace_id = $1 AND a.record_kind = 'firm' AND f.status = 'active'
        AND a.alias_kind IN ('external_id', 'domain', 'name')`,
    [workspaceId],
  );
  for (const alias of aliases.rows) {
    const firm = byId.get(alias.firm_id);
    if (firm === undefined) continue;
    if (alias.alias_kind === 'external_id') pushTo(byExternalId, alias.alias_value, firm);
    if (alias.alias_kind === 'name') pushTo(byName, firmNameKey(alias.alias_value), firm);
    if (alias.alias_kind === 'domain') {
      const domain = websiteDomain(alias.alias_value);
      if (domain !== null) pushTo(byDomain, domain, firm);
    }
  }

  const people = await context.db.query<{ firm_id: string; full_name: string }>(
    `SELECT firm_id, full_name FROM contacts WHERE workspace_id = $1 AND status <> 'merged'`,
    [workspaceId],
  );
  const addresses = await context.db.query<{ firm_id: string; address: string }>(
    `SELECT e.firm_id, e.address
       FROM email_addresses e
       JOIN contacts c ON c.workspace_id = e.workspace_id AND c.id = e.contact_id
      WHERE e.workspace_id = $1 AND c.status <> 'merged'`,
    [workspaceId],
  );
  const contacts = new Map<string, Set<string>>();
  const keyed = (firmId: string, key: string): void => {
    const set = contacts.get(firmId) ?? new Set<string>();
    set.add(key);
    contacts.set(firmId, set);
  };
  for (const person of people.rows) keyed(person.firm_id, `name:${firmNameKey(person.full_name)}`);
  for (const address of addresses.rows) keyed(address.firm_id, `email:${address.address}`);

  return { byExternalId, byDomain, byName, contacts };
}

/** A firm this file creates, as later rows are matched against it. */
interface FileFirm {
  readonly rowNumber: number;
  readonly domain: string | null;
}

type Matched =
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly column: ImportColumn }
  | { readonly kind: 'match'; readonly match: ImportFirmMatch };

/**
 * A name matches only where the websites do not contradict it: two firms with the same
 * name and different domains are two firms. Where either side has no website, the name
 * is all there is to go on.
 */
function nameCompatible(rowDomain: string | null, candidateDomain: string | null): boolean {
  return rowDomain === null || candidateDomain === null || rowDomain === candidateDomain;
}

function matchExisting(index: WorkspaceIndex, firm: ImportFirmDraft): Matched {
  const one = (
    found: readonly IndexedFirm[] | undefined,
    matchedOn: 'external_id' | 'domain' | 'name',
    column: ImportColumn,
  ): Matched | null => {
    if (found === undefined || found.length === 0) return null;
    const [only] = found;
    if (found.length > 1 || only === undefined) return { kind: 'ambiguous', column };
    return { kind: 'match', match: { kind: 'existing', firmId: only.id, firmName: only.name, matchedOn } };
  };
  const domain = websiteDomain(firm.website);
  return (
    (firm.externalId === null ? null : one(index.byExternalId.get(firm.externalId), 'external_id', 'external_id')) ??
    (domain === null ? null : one(index.byDomain.get(domain), 'domain', 'website')) ??
    one(
      index.byName.get(firmNameKey(firm.name))?.filter(candidate => nameCompatible(domain, candidate.domain)),
      'name',
      'firm_name',
    ) ?? { kind: 'none' }
  );
}

function matchInFile(
  byDomain: ReadonlyMap<string, FileFirm>,
  byName: ReadonlyMap<string, FileFirm>,
  firm: ImportFirmDraft,
): ImportFirmMatch | null {
  const domain = websiteDomain(firm.website);
  const sameDomain = domain === null ? undefined : byDomain.get(domain);
  if (sameDomain !== undefined) return { kind: 'in_file', rowNumber: sameDomain.rowNumber, matchedOn: 'domain' };
  const sameName = byName.get(firmNameKey(firm.name));
  if (sameName !== undefined && nameCompatible(domain, sameName.domain)) {
    return { kind: 'in_file', rowNumber: sameName.rowNumber, matchedOn: 'name' };
  }
  return null;
}

function matchColumn(match: ImportFirmMatch): ImportColumn {
  if (match.matchedOn === 'domain') return 'website';
  if (match.matchedOn === 'external_id') return 'external_id';
  return 'firm_name';
}

const DUPLICATE_CODES: ReadonlySet<ImportIssueCode> = new Set(['duplicate_in_file', 'duplicate_in_workspace']);

/** Classify drafts, in file order, against the workspace and against each other. */
async function classify(context: RepositoryContext, drafts: readonly RowDraft[]): Promise<ImportPreviewRow[]> {
  const owners = await knownOwners(
    context,
    drafts.map(draft => draft.firm.ownerUserId).filter((value): value is string => value !== null),
  );
  const index = await workspaceIndex(context);

  const fileByDomain = new Map<string, FileFirm>();
  const fileByName = new Map<string, FileFirm>();
  /** `firm:<id>` or `row:<n>` to the contact keys this file has already put there. */
  const fileContacts = new Map<string, Set<string>>();

  const rows: ImportPreviewRow[] = [];
  for (const draft of drafts) {
    const issues = [...draft.issues];
    if (draft.firm.ownerUserId !== null && !owners.has(draft.firm.ownerUserId)) {
      issues.push({ column: 'owner_user_id', code: 'owner_unknown' });
    }

    let match: ImportFirmMatch | null = null;
    if (draft.firm.name.length > 0) {
      const existing = matchExisting(index, draft.firm);
      if (existing.kind === 'ambiguous') issues.push({ column: existing.column, code: 'firm_ambiguous' });
      else if (existing.kind === 'match') match = existing.match;
      else match = matchInFile(fileByDomain, fileByName, draft.firm);
    }

    const key = contactKey(draft.contact, draft.routes);
    const target = match === null ? null : match.kind === 'existing' ? `firm:${match.firmId}` : `row:${String(match.rowNumber)}`;
    if (match !== null && target !== null) {
      const inFile = match.kind === 'in_file';
      if (key === null) {
        // Only a firm, and the firm is already there: nothing to add.
        issues.push({ column: matchColumn(match), code: inFile ? 'duplicate_in_file' : 'duplicate_in_workspace' });
      } else if (fileContacts.get(target)?.has(key) === true) {
        issues.push({ column: contactColumn(key), code: 'duplicate_in_file' });
      } else if (match.kind === 'existing' && index.contacts.get(match.firmId)?.has(key) === true) {
        issues.push({ column: contactColumn(key), code: 'duplicate_in_workspace' });
      }
    }

    // Invalid beats duplicate: a row that is both is shown the fault it can fix.
    const invalid = issues.some(issue => !DUPLICATE_CODES.has(issue.code));
    const duplicate = issues.some(issue => DUPLICATE_CODES.has(issue.code));
    const outcome: ImportRowOutcome = invalid ? 'invalid' : duplicate ? 'duplicate' : match !== null ? 'attach' : 'create';

    if (outcome === 'create') {
      const created: FileFirm = { rowNumber: draft.rowNumber, domain: websiteDomain(draft.firm.website) };
      if (created.domain !== null && !fileByDomain.has(created.domain)) fileByDomain.set(created.domain, created);
      const nameKey = firmNameKey(draft.firm.name);
      if (!fileByName.has(nameKey)) fileByName.set(nameKey, created);
    }
    if ((outcome === 'create' || outcome === 'attach') && key !== null) {
      const place = outcome === 'create' ? `row:${String(draft.rowNumber)}` : (target ?? '');
      const set = fileContacts.get(place) ?? new Set<string>();
      set.add(key);
      fileContacts.set(place, set);
    }

    rows.push({
      rowNumber: draft.rowNumber,
      outcome,
      issues,
      firm: draft.firm,
      contact: draft.contact,
      routes: draft.routes,
      match: invalid ? null : match,
    });
  }
  return rows;
}

function countsOf(rows: readonly ImportPreviewRow[]): Readonly<Record<ImportRowOutcome, number>> {
  return {
    create: rows.filter(row => row.outcome === 'create').length,
    attach: rows.filter(row => row.outcome === 'attach').length,
    duplicate: rows.filter(row => row.outcome === 'duplicate').length,
    invalid: rows.filter(row => row.outcome === 'invalid').length,
  };
}

export async function previewCsvImport(
  context: RepositoryContext,
  input: { readonly csv: string },
): Promise<ImportResult<ImportPreview>> {
  // Before a byte is parsed: 5.2 makes import an administrator's command.
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refused(permitted.reason);

  const parsed = parseCsv(input.csv);
  if (!parsed.ok) return refused(parsed.reason, { column: parsed.column, rowNumber: parsed.rowNumber });

  const header = parsed.value.header;
  const drafts = parsed.value.rows.map(row =>
    draftOf(row.number, column => {
      const at = header.indexOf(column);
      return at === -1 ? '' : (row.fields[at] ?? '');
    }),
  );
  const rows = await classify(context, drafts);
  return accepted({ rows, counts: countsOf(rows) });
}

export interface ImportRowCommitted {
  readonly rowNumber: number;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly routeIds: readonly string[];
  /** Whether the row made its firm or added its contact to one already there. */
  readonly outcome: 'created' | 'attached';
}

const ROW_SAVEPOINT = 'crm_capture_row';

/**
 * Run one row's writes so that a refusal undoes all of them and nothing before them.
 *
 * Inside a transaction — every command, through `runCommand` — this is a savepoint, so
 * the refusal's receipt still commits and the row's own firm, contact and routes do not.
 * Outside one, which only a test calling the domain directly on an autocommit session
 * does, the row is its own transaction, which gives the same answer. An exception rolls
 * the row back and propagates, so the caller's transaction rolls back with it. The
 * pattern is `dial/calls.ts`'s (audit item C14).
 */
async function withinRowSavepoint<T>(
  context: RepositoryContext,
  work: () => Promise<ImportResult<T>>,
): Promise<ImportResult<T>> {
  let nested = true;
  try {
    await context.db.query(`SAVEPOINT ${ROW_SAVEPOINT}`);
  } catch (error) {
    // 25P01 no_active_sql_transaction: not inside a transaction block.
    if ((error as { code?: string }).code !== '25P01') throw error;
    nested = false;
    await context.db.query('BEGIN');
  }
  const undo = async (): Promise<void> => {
    if (nested) {
      await context.db.query(`ROLLBACK TO SAVEPOINT ${ROW_SAVEPOINT}`);
      await context.db.query(`RELEASE SAVEPOINT ${ROW_SAVEPOINT}`);
    } else {
      await context.db.query('ROLLBACK');
    }
  };
  let result: ImportResult<T>;
  try {
    result = await work();
  } catch (error) {
    await undo();
    throw error;
  }
  if (result.ok) await context.db.query(nested ? `RELEASE SAVEPOINT ${ROW_SAVEPOINT}` : 'COMMIT');
  else await undo();
  return result;
}

/** Whether a contact with this key is already at the firm. Read inside the row's transaction. */
async function contactAlreadyAt(context: RepositoryContext, firmId: string, key: string): Promise<boolean> {
  if (key.startsWith('email:')) {
    const { rows } = await context.db.query(
      `SELECT 1 FROM email_addresses e
         JOIN contacts c ON c.workspace_id = e.workspace_id AND c.id = e.contact_id
        WHERE e.workspace_id = $1 AND e.firm_id = $2 AND e.address = $3 AND c.status <> 'merged'
        LIMIT 1`,
      [context.scope.workspaceId, firmId, key.slice('email:'.length)],
    );
    return rows.length > 0;
  }
  const { rows } = await context.db.query<{ full_name: string }>(
    `SELECT full_name FROM contacts WHERE workspace_id = $1 AND firm_id = $2 AND status <> 'merged'`,
    [context.scope.workspaceId, firmId],
  );
  return rows.some(row => `name:${firmNameKey(row.full_name)}` === key);
}

interface CaptureOptions {
  /** Where the routes came from: `import` for a file, `salesperson` for a person typing. */
  readonly source: RouteSource;
  /** Row number to the firm an earlier row of the same file committed, for `in_file` matches. */
  readonly committedFirmIds?: ReadonlyMap<number, string>;
}

/**
 * Commit one classified row through the ordinary commands.
 *
 * The row is re-checked rather than trusted: a preview is a value a client holds and
 * may edit, so a row with any issue is refused with its first issue's code and column,
 * and the routes are re-validated against the same patterns. The firm is the one the
 * row matched; for a firm an earlier row creates, the one that row committed; and
 * otherwise a new firm made from the row's own columns — which is what a row whose
 * creating row was refused or not asked for gets, because it carries the firm's columns
 * too. A contact that arrived at the firm between the preview and now is a duplicate.
 */
async function captureRow(
  context: RepositoryContext,
  row: ImportPreviewRow,
  options: CaptureOptions,
): Promise<ImportResult<ImportRowCommitted>> {
  const at = { rowNumber: row.rowNumber };
  const first = row.issues[0];
  if (first !== undefined) return refused(first.code, { ...at, column: first.column, issues: row.issues });
  if (row.outcome !== 'create' && row.outcome !== 'attach') return refused('invalid_input', at);
  if (row.firm.name.trim().length === 0) return refused('firm_name_missing', { ...at, column: 'firm_name' });
  for (const route of row.routes) {
    const valid = route.kind === 'email' ? EMAIL.test(route.value) : E164.test(route.value);
    if (!valid) return refused(route.kind === 'email' ? 'email_invalid' : 'phone_invalid', { ...at, column: route.kind === 'email' ? 'contact_email' : 'contact_phone' });
  }

  return await withinRowSavepoint(context, async () => {
    const match = row.match;
    let firmId: string | null =
      match === null ? null : match.kind === 'existing' ? match.firmId : (options.committedFirmIds?.get(match.rowNumber) ?? null);
    const creating = firmId === null;

    if (firmId === null) {
      // Assigned to whoever captured it unless the row names an owner: a firm nobody is
      // assigned to is on nobody's list but an admin's, and `authorizeDial` refuses it to
      // everybody, the admin included (9.2 step 4).
      const owner = row.firm.ownerUserId ?? actorUserId(context);
      const firm = await createFirm(context, {
        name: row.firm.name,
        ...(row.firm.website === null ? {} : { website: row.firm.website }),
        ...(row.firm.addressLine === null ? {} : { addressLine: row.firm.addressLine }),
        ...(row.firm.locality === null ? {} : { locality: row.firm.locality }),
        ...(row.firm.regionCode === null ? {} : { regionCode: row.firm.regionCode }),
        ...(row.firm.postalCode === null ? {} : { postalCode: row.firm.postalCode }),
        ...(row.firm.externalId === null ? {} : { externalId: row.firm.externalId }),
        ...(owner === null ? {} : { assignedUserId: owner }),
      });
      if (!firm.ok) return refused(firm.reason, { ...at, column: firm.reason === 'assignee_unknown' ? 'owner_user_id' : null });
      firmId = firm.value.id;
      // The zone the row recorded, or the one its state and ZIP establish under the
      // versioned source rule (9.2). A firm whose zone cannot be established is still a
      // firm; its calls are held until somebody records one, which is what 9.2 asks.
      const zone = await resolveZoneForFirm(context, {
        firmId,
        ...(row.firm.timeZone === null ? {} : { recordedZone: row.firm.timeZone }),
      });
      if (!zone.ok && zone.reason !== 'zone_unresolved') return refused(zone.reason, at);
    } else {
      const key = contactKey(row.contact, row.routes);
      if (key === null) return refused('duplicate_in_workspace', { ...at, column: match === null ? 'firm_name' : matchColumn(match), firmId });
      if (await contactAlreadyAt(context, firmId, key)) {
        return refused('duplicate_in_workspace', { ...at, column: contactColumn(key), firmId });
      }
    }

    let contactId: string | null = null;
    if (row.contact !== null) {
      const contact = await createContact(context, {
        firmId,
        fullName: row.contact.fullName,
        ...(row.contact.title === null ? {} : { title: row.contact.title }),
        // The first person at a new firm is its main contact; a person added to a firm
        // that already has people does not displace whoever is.
        isPrimary: creating,
      });
      if (!contact.ok) return refused(contact.reason, at);
      contactId = contact.value.id;
    }

    const routeIds: string[] = [];
    for (const route of row.routes) {
      // Section 7.2 asks a route to record where it came from, and `decideRouteEligibility`
      // decides what that makes it. Neither a spreadsheet nor a person typing a number has
      // passed technical validation, so both land as `candidate`, the state the domain gives
      // every unverified route (route-policy.1); only a verification makes one `usable`.
      const added =
        route.kind === 'email'
          ? await addEmailRoute(context, {
              firmId,
              ...(contactId === null ? {} : { contactId }),
              address: route.value,
              source: options.source,
            })
          : await addPhoneRoute(context, {
              firmId,
              ...(contactId === null ? {} : { contactId }),
              e164: route.value,
              source: options.source,
            });
      if (!added.ok) return refused(added.reason, at);
      routeIds.push(added.value.id);
    }

    return accepted({ rowNumber: row.rowNumber, firmId, contactId, routeIds, outcome: creating ? 'created' : 'attached' });
  });
}

/**
 * Commit one previewed row of a file (Appendix G 38). Admin-only, like the preview.
 *
 * The caller supplies the transaction — in the API that is `runCommand`, which commits
 * the receipt with the mutation — and, for a row matched to a firm an earlier row of the
 * same file creates, that row's committed firm id.
 */
export async function commitImportRow(
  context: RepositoryContext,
  row: ImportPreviewRow,
  options: { readonly committedFirmIds?: ReadonlyMap<number, string> } = {},
): Promise<ImportResult<ImportRowCommitted>> {
  const permitted = decideAdminOnly(context);
  if (!permitted.permitted) return refused(permitted.reason, { rowNumber: row.rowNumber });
  return await captureRow(context, row, {
    source: 'import',
    ...(options.committedFirmIds === undefined ? {} : { committedFirmIds: options.committedFirmIds }),
  });
}

/** What the Add firm form sends: strings as typed, blank for a field left empty. */
export interface AddFirmInput {
  readonly firm: {
    readonly name: string;
    readonly website?: string | undefined;
    readonly timeZone?: string | undefined;
  };
  readonly contact?:
    | {
        readonly fullName: string;
        readonly title?: string | undefined;
        readonly email?: string | undefined;
        readonly phone?: string | undefined;
      }
    | undefined;
}

/**
 * Add a firm, its first contact and that contact's email address and number, from the
 * Add firm form (audit item G02).
 *
 * It is one row of an import typed into a form: the same checks, the same matching and
 * the same commit, so a firm added by hand and a firm imported from a file cannot differ
 * in what they are allowed to be. Two things differ, both because a person is typing:
 * it is not admin-only — `createFirm` lets a salesperson create a firm assigned to
 * themselves (7.2), and that is who it is assigned to — and the routes are recorded as a
 * salesperson's, the source 7.4 trusts for association once they are verified.
 *
 * A firm that is already here is refused with its id rather than added to: a button
 * called Add firm that quietly edited a different firm would be a surprise. Every field
 * at fault is named in `issues`, so the form marks them all at once.
 */
export async function addFirm(context: RepositoryContext, input: AddFirmInput): Promise<ImportResult<ImportRowCommitted>> {
  const values: Partial<Record<ImportColumn, string>> = {
    firm_name: input.firm.name,
    website: input.firm.website ?? '',
    time_zone: input.firm.timeZone ?? '',
    contact_name: input.contact?.fullName ?? '',
    contact_title: input.contact?.title ?? '',
    contact_email: input.contact?.email ?? '',
    contact_phone: input.contact?.phone ?? '',
  };
  const [row] = await classify(context, [draftOf(0, column => values[column] ?? '')]);
  if (row === undefined) return refused('invalid_input');
  const first = row.issues.find(issue => !DUPLICATE_CODES.has(issue.code));
  if (first !== undefined) return refused(first.code, { column: first.column, issues: row.issues });
  if (row.match !== null) {
    return refused('duplicate_in_workspace', {
      column: matchColumn(row.match),
      issues: [{ column: matchColumn(row.match), code: 'duplicate_in_workspace' }],
      ...(row.match.kind === 'existing' ? { firmId: row.match.firmId } : {}),
    });
  }
  return await captureRow(context, row, { source: 'salesperson' });
}
