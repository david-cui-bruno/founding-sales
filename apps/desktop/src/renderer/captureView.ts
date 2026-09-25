import type {
  ImportColumn,
  ImportCommitResult,
  ImportIssueCode,
  ImportIssueDto,
  ImportPreviewResponse,
  ImportPreviewRowDto,
  ImportRowOutcomeDto,
} from '@fss/contracts';
import type { AddFirmView, ImportFileRefusalView } from './firmWorkspaceContract.ts';

/**
 * What the Add firm form and the Import screen say, as pure functions of what the server
 * answered (lane g84, audit item G02).
 *
 * The same split as `firmWorkspaceView.ts`: nothing here is a rule. Whether a website is
 * a website, whether a row is a duplicate and which firm it belongs to are the server's
 * answers; this file turns each code into one fixed sentence and each column into the
 * label of the field a person sees, so the words are versioned with the release and one
 * code never says two things.
 */

/** The label each import column has on screen: the form's field, or the file's column. */
export const COLUMN_LABELS: Readonly<Record<ImportColumn, string>> = Object.freeze({
  firm_name: 'Firm',
  website: 'Website',
  address_line: 'Address',
  locality: 'City',
  region_code: 'State',
  postal_code: 'ZIP',
  external_id: 'External id',
  owner_user_id: 'Owner',
  contact_name: 'Contact',
  contact_title: 'Title',
  contact_email: 'Email',
  contact_phone: 'Phone',
  time_zone: 'Time zone',
});

/** One sentence per issue code. Every code in `IMPORT_ISSUE_CODES` has one; a test says so. */
export const ISSUE_SENTENCES: Readonly<Record<ImportIssueCode, string>> = Object.freeze({
  firm_name_missing: 'A firm needs a name.',
  website_invalid: 'Not a website Callie can read. Use a domain such as acme.com, or the full address.',
  region_code_invalid: 'A state is two letters, such as RI.',
  postal_code_invalid: 'Not a ZIP code.',
  email_invalid: 'Not an email address.',
  phone_invalid: 'Not a number Callie can dial. Use ten digits, or + and the country code.',
  contact_name_missing: 'A title, an email or a phone needs a person’s name beside it.',
  owner_unknown: 'Nobody in this workspace has that user id.',
  duplicate_in_file: 'Already on an earlier row of this file.',
  duplicate_in_workspace: 'Already here.',
  time_zone_invalid: 'Not a time zone Callie knows. Use a name such as America/New_York.',
  firm_ambiguous: 'Matches more than one firm here. Merge them first.',
  too_long: 'Too long for this field.',
});

export function issueSentence(code: string): string {
  return (ISSUE_SENTENCES as Readonly<Record<string, string>>)[code] ?? 'Callie could not accept this value.';
}

export function columnLabel(column: string): string {
  return (COLUMN_LABELS as Readonly<Record<string, string>>)[column] ?? column;
}

/** "Email: Not an email address." — one issue, under the field or the row it is about. */
export function issueLine(issue: ImportIssueDto): string {
  return `${columnLabel(issue.column)}: ${issueSentence(issue.code)}`;
}

// ---------------------------------------------------------------------------
// Add firm
// ---------------------------------------------------------------------------

/**
 * The zones the form offers: the six US zones a wealth-management firm is in, and "not
 * sure". "Not sure" leaves the zone to the firm's state and ZIP, which a firm added from
 * this form does not have, so its calls wait until somebody sets one — 9.2's "inability
 * to establish it blocks calling", said where the choice is made.
 */
export const TIME_ZONE_CHOICES: readonly { readonly value: string; readonly label: string }[] = Object.freeze([
  { value: '', label: 'Not sure — calls wait until it is set' },
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
]);

/** The form's fields, the column each stands for, and the bound the command schema sets. */
export const ADD_FIRM_FIELDS = Object.freeze([
  { key: 'name', column: 'firm_name', label: 'Firm name', maxLength: 300, placeholder: '' },
  { key: 'website', column: 'website', label: 'Website', maxLength: 500, placeholder: 'acme.com' },
  { key: 'contactName', column: 'contact_name', label: 'Name', maxLength: 200, placeholder: '' },
  { key: 'contactTitle', column: 'contact_title', label: 'Title', maxLength: 200, placeholder: 'Principal' },
  { key: 'contactEmail', column: 'contact_email', label: 'Email', maxLength: 320, placeholder: 'name@acme.com' },
  { key: 'contactPhone', column: 'contact_phone', label: 'Phone', maxLength: 40, placeholder: '401 555 0123' },
] as const);

/** The issues the last refusal named for one field, as sentences. */
export function fieldIssues(view: AddFirmView | null, column: ImportColumn): readonly string[] {
  return (view?.issues ?? []).filter(issue => issue.column === column).map(issue => issueSentence(issue.code));
}

/**
 * The one check the form makes before it sends: a firm with no name. It is the server's
 * rule too, and this is the client not sending a command it can already see is empty —
 * a courtesy, like the Lost reason's, and tested on both sides.
 */
export function addFirmSubmittable(name: string, actionsEnabled: boolean): boolean {
  return actionsEnabled && name.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** What the Import screen says about the file's shape, before any file is chosen. */
export const IMPORT_FORMAT_LINES: readonly string[] = Object.freeze([
  'One row per contact, with the firm’s columns repeated on each of its rows. A header row is required.',
  'Columns: firm_name (required), website, contact_name, contact_title, contact_email, contact_phone, time_zone, address_line, locality, region_code, postal_code, external_id, owner_user_id.',
  'A firm already here is matched by its website, then by its name; a contact by email. Nothing is imported until you press Import.',
]);

/** A refused file, in one sentence that names the header or the line at fault. */
export function fileRefusalSentence(refusal: ImportFileRefusalView): string {
  switch (refusal.reason) {
    case 'csv_empty':
      return 'The file is empty, or has no header row.';
    case 'csv_column_unknown':
      return `The column “${refusal.column ?? ''}” is not one Callie imports. Remove it or rename it.`;
    case 'csv_column_repeated':
      return `The column “${refusal.column ?? ''}” appears twice.`;
    case 'csv_row_width':
      return `Line ${String(refusal.rowNumber ?? '?')} has a different number of cells from the header.`;
    case 'csv_too_many_rows':
      return 'The file has more than 2,000 rows. Split it and import each part.';
    default:
      return 'Callie could not read this file.';
  }
}

export const OUTCOME_LABELS: Readonly<Record<ImportRowOutcomeDto, string>> = Object.freeze({
  create: 'New firm',
  attach: 'Adds a contact',
  duplicate: 'Already here',
  invalid: 'Fix',
});

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** "5 rows · 2 new firms · 1 contact added to a firm · 1 already here · 1 to fix". */
export function importSummary(preview: ImportPreviewResponse): string {
  const { create, attach, duplicate, invalid } = preview.counts;
  return [
    counted(preview.rows.length, 'row', 'rows'),
    create > 0 ? counted(create, 'new firm', 'new firms') : null,
    attach > 0 ? `${counted(attach, 'contact', 'contacts')} added to a firm` : null,
    duplicate > 0 ? `${String(duplicate)} already here` : null,
    invalid > 0 ? `${String(invalid)} to fix` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** How many rows the Import button commits: every new firm and every added contact. */
export function committableCount(preview: ImportPreviewResponse | null): number {
  return preview === null ? 0 : preview.counts.create + preview.counts.attach;
}

/** "Kim Placeholder · kim@acme.com · +14015550123", or the firm's website for a firm-only row. */
export function rowDetail(row: ImportPreviewRowDto): string {
  const parts = [
    row.contact?.fullName ?? null,
    ...row.routes.map(route => route.value),
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(' · ') : (row.firm.website ?? '');
}

/** Which firm a row adds its contact to, or is a duplicate of, when it is not a new one. */
export function matchLine(row: ImportPreviewRowDto): string | null {
  const match = row.match;
  if (match === null) return null;
  if (match.kind === 'existing') return `${match.firmName}, already here`;
  return `the firm on row ${String(match.rowNumber)}`;
}

const COMMIT_REASONS: Readonly<Record<string, string>> = Object.freeze({
  row_unknown: 'This row is not in the file any more. Preview the file again.',
  row_repeated: 'This row was asked for twice.',
  command_payload_mismatch: 'This row changed since it was first imported. Preview the file again.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  admin_only: 'Only an administrator can import.',
  not_assigned: 'That firm is assigned to somebody else.',
  firm_merged: 'That firm was merged into another. Preview the file again.',
  assignee_unknown: 'Nobody in this workspace has that user id.',
});

/** One committed row, in a line: what happened, or where and why it was refused. */
export function commitLine(result: ImportCommitResult): string {
  const row = `Row ${String(result.rowNumber)}`;
  if (result.status === 'accepted') {
    return result.outcome === 'attached' ? `${row} · contact added` : `${row} · imported`;
  }
  const reason = result.reason ?? 'refused';
  const column = result.column ?? null;
  if (column !== null) return `${row} · ${columnLabel(column)}: ${issueSentence(reason)}`;
  const sentence = COMMIT_REASONS[reason] ?? (reason in ISSUE_SENTENCES ? issueSentence(reason) : `Refused (${reason}).`);
  return `${row} · ${sentence}`;
}

/** "11 imported · 1 refused", counting what the server says landed. */
export function resultsSummary(results: readonly ImportCommitResult[]): string {
  const accepted = results.filter(result => result.status === 'accepted').length;
  const refused = results.length - accepted;
  return refused === 0 ? `${String(accepted)} imported` : `${String(accepted)} imported · ${String(refused)} refused`;
}
