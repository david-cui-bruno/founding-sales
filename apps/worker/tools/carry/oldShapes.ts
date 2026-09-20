/**
 * The old DynamoDB table's item shapes, as this carry reads them (lane G11;
 * specification 2 "Data carry" and 17).
 *
 * The shapes are copied from the old worker at the tag `dynamo-rebuild-final`:
 * `cloud/lambdas/delegated-worker/src/v1/firmsWrite.ts` (`FIRM#`),
 * `.../v1/evidence.ts` (`EVIDENCE#`), `.../v1/suppression.ts` (`SUPPRESS#FIRM#` and
 * `SUPPRESS#<handle>`) and `.../v1/templates.ts` (`TEMPLATE#`), plus the older
 * `ACCOUNT#` firm record the same tree's `v1/firms.ts` reads. Nothing under `cloud/`
 * is imported: that tree compiles without `strictNullChecks`, depends on the AWS SDK
 * and on `src/`, and is deleted by a later lane. What is copied is the *shape*, in
 * this file, with a comment naming where each field came from.
 *
 * ## Why a hand-written reader rather than a schema library
 *
 * The same reason `packages/domain/crm/import.ts` writes its own CSV parser: it is
 * eighty lines, it reads exactly the fields the carry uses, and it adds no dependency
 * to a workspace that has none. The worker's `package.json` gains nothing and the
 * lock file is not touched.
 *
 * ## Why an unreadable record is a refusal and not a skip
 *
 * The old worker skipped a row its schema refused — correct for a read model that
 * can be rebuilt, wrong for a carry that happens once. A firm silently dropped here
 * is a firm nobody ever calls again, and a suppression silently dropped here is
 * invariant 4 broken. So `readOldRecord` refuses, the export counts the refusals and
 * fails the run, and David fixes the record or the reader before an artifact exists.
 */

export const CARRY_KINDS = ['firm', 'evidence', 'suppression', 'template'] as const;
export type CarryKind = (typeof CARRY_KINDS)[number];

/** One item of the old table: its sort key, its partition, and its record body. */
export interface OldItem {
  readonly sk: string;
  readonly workspaceId: string;
  readonly data: unknown;
}

/** A route on a carried firm. `purpose: 'business'` is the only one the old shape had. */
export interface CarriedRoute {
  readonly oldRouteId: string;
  readonly channel: 'phone' | 'email';
  readonly value: string;
}

export interface CarriedFirm {
  readonly firmId: string;
  readonly name: string;
  readonly website: string | null;
  readonly locality: string | null;
  /** The two-letter state the old record carried, or null. Never a zone: see below. */
  readonly regionCode: string | null;
  readonly routes: readonly CarriedRoute[];
  /** Which old sort key this firm came from. `FIRM#` wins where both exist. */
  readonly shape: 'FIRM#' | 'ACCOUNT#';
}

export interface CarriedEvidenceSource {
  readonly sourceId: string;
  readonly url: string;
  readonly fetchedAt: string;
  readonly sha256: string;
  readonly excerpt: string;
}

export interface CarriedEvidence {
  readonly firmId: string;
  readonly revision: number;
  readonly sources: readonly CarriedEvidenceSource[];
}

export type CarriedSuppression =
  | { readonly scope: 'firm'; readonly firmId: string }
  | { readonly scope: 'handle'; readonly handle: string; readonly channel: 'phone' | 'email'; readonly firmId: string | null };

export interface CarriedTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  /** The old record's revision. It becomes the version; the approval does not travel. */
  readonly revision: number;
}

interface RecordBase {
  /** The old item's own identifier: the firm id, the handle, the template id. */
  readonly oldId: string;
  /** The sort key, for the audit trail. Never printed in a refusal. */
  readonly sk: string;
  /** The instant the old record itself records. The watermark is compared with this. */
  readonly recordedAt: string;
}

export type OldRecord =
  | (RecordBase & { readonly kind: 'firm'; readonly firm: CarriedFirm })
  | (RecordBase & { readonly kind: 'evidence'; readonly evidence: CarriedEvidence })
  | (RecordBase & { readonly kind: 'suppression'; readonly suppression: CarriedSuppression })
  | (RecordBase & { readonly kind: 'template'; readonly template: CarriedTemplate });

export type ReadRefusal = 'sk_unknown' | 'record_unreadable';

export type ReadResult =
  | { readonly ok: true; readonly value: OldRecord }
  | { readonly ok: false; readonly reason: ReadRefusal; readonly kind: CarryKind | null };

const refuse = (reason: ReadRefusal, kind: CarryKind | null = null): ReadResult => ({ ok: false, reason, kind });
const accept = (value: OldRecord): ReadResult => ({ ok: true, value });

/* ------------------------------------------------------------------------- */
/* Small readers. Each answers `null` rather than throwing or coercing.        */
/* ------------------------------------------------------------------------- */

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, maximum = 2048): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum ? value : null;
}

function nullableText(value: unknown, maximum = 2048): string | null | undefined {
  if (value === null) return null;
  return text(value, maximum) ?? undefined;
}

/**
 * The old record's `domain` — "lower-case, or null. Never a URL" — as the greenfield
 * `firms.website`, which `firms_website_shape` requires to be one.
 *
 * The scheme is the one piece of information the carry adds, and `https` is the only
 * honest choice: it is what the old research fetched the firm's pages over, and a
 * carry that wrote `http` would be recording a claim about the firm's site that
 * nothing in the old table supports.
 *
 * A value that is not a domain is `undefined` here, which makes the record
 * unreadable and fails the export — rather than reaching PostgreSQL and failing the
 * whole run with a constraint violation nobody can act on.
 */
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u;

function websiteFromDomain(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const domain = text(value, 253);
  if (domain === null) return undefined;
  const lowered = domain.trim().toLowerCase();
  return DOMAIN.test(lowered) ? `https://${lowered}` : undefined;
}

/** An ISO-8601 instant the old records all store as a string. */
function instant(value: unknown): string | null {
  const raw = text(value, 64);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function routes(value: unknown): readonly CarriedRoute[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const carried: CarriedRoute[] = [];
  for (const entry of value) {
    const row = object(entry);
    if (row === null) return null;
    const channel = row['channel'];
    // A route of any other channel is not a refusal: the old shape allowed kinds the
    // greenfield route tables have no column for, and they are not part of the carry.
    if (channel !== 'phone' && channel !== 'email') continue;
    const id = text(row['id'], 200);
    const raw = text(row['value'], 254);
    if (id === null || raw === null) return null;
    carried.push({ oldRouteId: id, channel, value: raw });
  }
  return carried;
}

/* ------------------------------------------------------------------------- */
/* The sort keys.                                                             */
/* ------------------------------------------------------------------------- */

export const OLD_PREFIXES = {
  firm: 'FIRM#',
  account: 'ACCOUNT#',
  evidence: 'EVIDENCE#',
  suppression: 'SUPPRESS#',
  template: 'TEMPLATE#',
} as const;

/** `SUPPRESS#FIRM#<firmId>`; a handle key is `SUPPRESS#<encodeURIComponent(handle)>`. */
const SUPPRESS_FIRM_PREFIX = 'SUPPRESS#FIRM#';

/**
 * A handle that happened to begin with `FIRM#` cannot be mistaken for a firm key:
 * the old writer put every handle through `encodeURIComponent`, which turns `#` into
 * `%23`. The two key spaces therefore do not overlap, and the prefix test below is
 * exact rather than a guess.
 */
export function isFirmSuppressionKey(sk: string): boolean {
  return sk.startsWith(SUPPRESS_FIRM_PREFIX);
}

/* ------------------------------------------------------------------------- */

function readFirmRecord(item: OldItem): ReadResult {
  const data = object(item.data);
  if (data === null) return refuse('record_unreadable', 'firm');
  const firmId = text(data['firmId'], 200);
  const name = text(data['name'], 300);
  const recordedAt = instant(data['updatedAt']);
  const website = websiteFromDomain(data['domain']);
  const locality = nullableText(data['city'], 200);
  const regionCode = nullableText(data['state'], 2);
  const carriedRoutes = routes(data['routes']);
  if (
    firmId === null ||
    name === null ||
    recordedAt === null ||
    website === undefined ||
    locality === undefined ||
    regionCode === undefined ||
    carriedRoutes === null
  ) {
    return refuse('record_unreadable', 'firm');
  }
  return accept({
    kind: 'firm',
    oldId: firmId,
    sk: item.sk,
    recordedAt,
    firm: {
      firmId,
      name: name.trim(),
      website,
      locality,
      regionCode: regionCode === null ? null : regionCode.toUpperCase(),
      routes: carriedRoutes,
      shape: 'FIRM#',
    },
  });
}

/**
 * The older `ACCOUNT#` record, read only where no `FIRM#` record exists for the same
 * firm — which is how the old copy itself read them (`v1/firms.ts`: a firm with no
 * `ACCOUNT#` row gets its card from its `FIRM#` record, and the reverse).
 *
 * It carries no state. The old core derived one from the Places listing's formatted
 * address inside the record's excerpts; reimplementing that here would be a guess at
 * a firm's location made by a tool that will never be run again. So the firm arrives
 * with no region and therefore no zone, which blocks calling (9.2) until the zone is
 * recorded deliberately. The runbook says so.
 */
function readAccountRecord(item: OldItem): ReadResult {
  const data = object(item.data);
  const account = data === null ? null : object(data['account']);
  if (data === null || account === null) return refuse('record_unreadable', 'firm');
  const firmId = text(account['id'], 200);
  const name = text(account['name'], 300);
  const website = websiteFromDomain(account['domain']);
  const carriedRoutes = routes(data['routes']);
  const history = data['history'];
  if (firmId === null || name === null || website === undefined || carriedRoutes === null) {
    return refuse('record_unreadable', 'firm');
  }
  if (!Array.isArray(history) || history.length === 0) return refuse('record_unreadable', 'firm');
  let recordedAt: string | null = null;
  for (const entry of history) {
    const row = object(entry);
    const at = row === null ? null : instant(row['at']);
    if (at === null) return refuse('record_unreadable', 'firm');
    if (recordedAt === null || at > recordedAt) recordedAt = at;
  }
  if (recordedAt === null) return refuse('record_unreadable', 'firm');
  return accept({
    kind: 'firm',
    oldId: firmId,
    sk: item.sk,
    recordedAt,
    firm: { firmId, name: name.trim(), website, locality: null, regionCode: null, routes: carriedRoutes, shape: 'ACCOUNT#' },
  });
}

function readEvidenceRecord(item: OldItem): ReadResult {
  const data = object(item.data);
  if (data === null) return refuse('record_unreadable', 'evidence');
  const firmId = text(data['firmId'], 200);
  const revision = positiveInteger(data['revision']);
  const recordedAt = instant(data['updatedAt']);
  const rawSources = data['sources'];
  if (firmId === null || revision === null || recordedAt === null || !Array.isArray(rawSources)) {
    return refuse('record_unreadable', 'evidence');
  }
  const sources: CarriedEvidenceSource[] = [];
  for (const entry of rawSources) {
    const row = object(entry);
    if (row === null) return refuse('record_unreadable', 'evidence');
    const sourceId = text(row['id'], 200);
    const url = text(row['url'], 2048);
    const fetchedAt = instant(row['fetchedAt']);
    const sha256 = text(row['sha256'], 64);
    const excerpt = typeof row['excerpt'] === 'string' ? row['excerpt'] : null;
    if (sourceId === null || url === null || fetchedAt === null || sha256 === null || excerpt === null) {
      return refuse('record_unreadable', 'evidence');
    }
    if (!HEX64.test(sha256)) return refuse('record_unreadable', 'evidence');
    sources.push({ sourceId, url, fetchedAt, sha256, excerpt });
  }
  return accept({ kind: 'evidence', oldId: firmId, sk: item.sk, recordedAt, evidence: { firmId, revision, sources } });
}

function readSuppressionRecord(item: OldItem): ReadResult {
  const data = object(item.data);
  if (data === null) return refuse('record_unreadable', 'suppression');
  const recordedAt = instant(data['at']);
  if (recordedAt === null) return refuse('record_unreadable', 'suppression');

  if (isFirmSuppressionKey(item.sk)) {
    const firmId = text(data['firmId'], 200);
    if (firmId === null) return refuse('record_unreadable', 'suppression');
    return accept({
      kind: 'suppression',
      oldId: `firm:${firmId}`,
      sk: item.sk,
      recordedAt,
      suppression: { scope: 'firm', firmId },
    });
  }

  const handle = text(data['handle'], 254);
  const channel = data['channel'];
  const firmId = nullableText(data['firmId'], 200);
  if (handle === null || (channel !== 'phone' && channel !== 'email') || firmId === undefined) {
    return refuse('record_unreadable', 'suppression');
  }
  return accept({
    kind: 'suppression',
    oldId: `handle:${handle}`,
    sk: item.sk,
    recordedAt,
    suppression: { scope: 'handle', handle, channel, firmId },
  });
}

function readTemplateRecord(item: OldItem): ReadResult {
  const data = object(item.data);
  if (data === null) return refuse('record_unreadable', 'template');
  const templateId = text(data['templateId'], 80);
  const name = text(data['name'], 120);
  const subject = text(data['subject'], 160);
  const body = text(data['body'], 4000);
  const revision = positiveInteger(data['revision']);
  const recordedAt = instant(data['updatedAt']);
  if (templateId === null || name === null || subject === null || body === null || revision === null || recordedAt === null) {
    return refuse('record_unreadable', 'template');
  }
  // `approval` is deliberately not read. Section 2 and 17 carry template *bodies*,
  // unapproved; an approval recorded against the old footer rule is not an approval
  // of anything the greenfield send fence would accept.
  return accept({
    kind: 'template',
    oldId: templateId,
    sk: item.sk,
    recordedAt,
    template: { templateId, name: name.trim(), subject, body, revision },
  });
}

/** Which kind a sort key belongs to, or null for a key this carry does not read. */
export function classifyOldKey(sk: string): CarryKind | 'account' | null {
  if (sk.startsWith(OLD_PREFIXES.firm)) return 'firm';
  if (sk.startsWith(OLD_PREFIXES.account)) return 'account';
  if (sk.startsWith(OLD_PREFIXES.evidence)) return 'evidence';
  if (sk.startsWith(OLD_PREFIXES.suppression)) return 'suppression';
  if (sk.startsWith(OLD_PREFIXES.template)) return 'template';
  return null;
}

/** One old item as the record the carry moves, or the reason it cannot be read. */
export function readOldRecord(item: OldItem): ReadResult {
  switch (classifyOldKey(item.sk)) {
    case 'firm':
      return readFirmRecord(item);
    case 'account':
      return readAccountRecord(item);
    case 'evidence':
      return readEvidenceRecord(item);
    case 'suppression':
      return readSuppressionRecord(item);
    case 'template':
      return readTemplateRecord(item);
    default:
      return refuse('sk_unknown');
  }
}
