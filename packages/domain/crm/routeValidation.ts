import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { decideFirmMutation } from './authorization.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { loadFirmForUpdate } from './firms.ts';
import { emailValidationJob, recordEmailRouteValidation, EMAIL_VALIDATION_ROUND_NEW } from './routes.ts';
import { accept, refuse, type CrmResult, type RouteRow, type RouteSource } from './types.ts';

/**
 * Email technical validation (specification 7.4; lane g90).
 *
 * Section 7.4: "Email and phone routes become `usable` only when a versioned
 * provider/source policy satisfies both technical-validation and association-confidence
 * thresholds." `route-policy.1` (`routePolicy.ts`) is the threshold half. This file is
 * the other half for an address: what `technical_validation = 'passed'` means, and the
 * job that finds out.
 *
 * ## What "passed" means — `email-validation.1`
 *
 * | Check | Outcome |
 * |---|---|
 * | The address is not RFC 5321-sane: more than 254 characters, a local part that is not a dot-atom of 1 to 64 ASCII characters, a domain that is not LDH labels of 1 to 63 with a letter in the last, an address literal | `failed`, `syntax_invalid` |
 * | The domain is, or is under, a name that never receives internet mail (RFC 2606, 6761, 6762, 7686, 9476, `.arpa`, `.internal`) | `failed`, `domain_reserved` |
 * | Another route in the workspace with the same address has *failed* validation (a bounce, or this check) | `failed`, `known_bad_route` |
 * | The domain publishes an MX with a real exchange | `passed`, `mx_present` |
 * | The domain publishes only RFC 7505's null MX (`0 .`) | `failed`, `null_mx` |
 * | The domain does not exist (NXDOMAIN) | `failed`, `domain_not_found` |
 * | No MX, and an A or AAAA record (RFC 5321 5.1, the implicit MX) | `passed`, `implicit_mx` |
 * | No MX, and no A or AAAA | `failed`, `no_mail_host` |
 * | A timeout, SERVFAIL, a refused query or any other resolver error | no answer: the route stays `unknown` and the sweep asks again |
 *
 * Deliberately **not** here: SMTP callouts (they probe a stranger's mail server and are
 * refused or lied to by the ones that matter), third-party verifiers, role mailboxes
 * (`info@`) and disposable-address lists. The last two are judgements about whether an
 * address is *worth* writing to, not about whether mail can reach it, and 7.4 asks for
 * the second. `docs/decisions/g90-email-technical-validation.md` has the reasoning for
 * each row, and for accepting the implicit MX.
 *
 * ## Association — what validation cannot supply
 *
 * A passed check says mail can reach the domain; it says nothing about whether the
 * address is this person's. `route-policy.1` needs a recorded confidence for that, and
 * an address a person typed into Add firm (`salesperson`) or put in their own import
 * file or the carry (`import`) arrives with none: until this lane, nothing could ever
 * make one usable. For those two sources the confidence recorded when the check passes
 * is 1 — the person who entered the address vouched for it, the same judgement lane g88
 * made for "Confirm this number" and the drill makes for its own address. A recorded
 * confidence is never replaced, and a research or website route with none stays a
 * candidate, because a provider that did not measure has not vouched for anything.
 */

export const EMAIL_VALIDATION_RULE_VERSION = 'email-validation.1';

export const EMAIL_VALIDATION_PASS_REASONS = ['mx_present', 'implicit_mx'] as const;
export const EMAIL_VALIDATION_FAIL_REASONS = [
  'syntax_invalid',
  'domain_reserved',
  'known_bad_route',
  'null_mx',
  'domain_not_found',
  'no_mail_host',
] as const;
export const EMAIL_VALIDATION_DEFER_REASONS = ['dns_timeout', 'dns_servfail', 'dns_refused', 'dns_error'] as const;

export type EmailValidationVerdict =
  | { readonly verdict: 'passed'; readonly reason: (typeof EMAIL_VALIDATION_PASS_REASONS)[number] }
  | { readonly verdict: 'failed'; readonly reason: (typeof EMAIL_VALIDATION_FAIL_REASONS)[number] }
  | { readonly verdict: 'deferred'; readonly reason: (typeof EMAIL_VALIDATION_DEFER_REASONS)[number] };

// ---------------------------------------------------------------------------
// Syntax
// ---------------------------------------------------------------------------

/** RFC 5321 4.5.3.1.3's 256-octet path, less its two angle brackets. */
export const EMAIL_ADDRESS_MAXIMUM_LENGTH = 254;
const LOCAL_PART_MAXIMUM_LENGTH = 64;
const DOMAIN_MAXIMUM_LENGTH = 253;
/** RFC 5322's dot-atom over atext. Quoted local parts are legal and never a prospect's. */
const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/u;
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export interface ParsedEmailAddress {
  readonly localPart: string;
  /** The domain as DNS is asked for it: lower case, internationalized labels as A-labels. */
  readonly domain: string;
}

/**
 * The address split and checked, or null when it is not RFC 5321-sane.
 *
 * "Sane" is narrower than legal on purpose: a quoted local part, a comment, an address
 * literal (`[192.0.2.1]`) and a non-ASCII local part (SMTPUTF8) are all things a sender
 * may meet in RFC 5321 and none is an address a law firm hands out. An internationalized
 * *domain* is fine: it is asked for as its A-label.
 */
export function parseEmailAddress(address: string): ParsedEmailAddress | null {
  if (address.length === 0 || address.length > EMAIL_ADDRESS_MAXIMUM_LENGTH) return null;
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return null;
  const localPart = address.slice(0, at);
  const rawDomain = address.slice(at + 1);
  if (localPart.length > LOCAL_PART_MAXIMUM_LENGTH || !DOT_ATOM.test(localPart)) return null;
  if (rawDomain.length === 0 || rawDomain.startsWith('[')) return null;

  // `domainToASCII` answers '' for anything the URL standard cannot make a host of.
  const domain = domainToASCII(rawDomain).toLowerCase();
  if (domain.length === 0 || domain.length > DOMAIN_MAXIMUM_LENGTH) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (!labels.every(label => LDH_LABEL.test(label))) return null;
  // RFC 3696 2: a top-level domain is never all-numeric, which is also what keeps a
  // dotted quad from passing as a domain.
  const top = labels[labels.length - 1] ?? '';
  if (!/[a-z]/u.test(top)) return null;
  return { localPart, domain };
}

// ---------------------------------------------------------------------------
// Names that never receive internet mail
// ---------------------------------------------------------------------------

/**
 * Special-use names: a domain equal to one of these, or under one, cannot receive mail
 * from the internet by definition. Answered without asking DNS, because some resolvers
 * answer for them anyway (a captive portal, a corporate split horizon) and a yes from
 * one of those would be wrong.
 *
 * This is the whole list, and it is short on purpose. Role mailboxes and disposable
 * providers are not on it: they receive mail.
 */
export const RESERVED_MAIL_DOMAINS: readonly string[] = Object.freeze([
  // RFC 2606 and RFC 6761.
  'test',
  'example',
  'invalid',
  'localhost',
  'example.com',
  'example.net',
  'example.org',
  // RFC 6762 (multicast DNS), RFC 7686 (Tor), RFC 9476 (alternative namespaces).
  'local',
  'onion',
  'alt',
  // Infrastructure (RFC 3172, including RFC 8375's home.arpa) and ICANN's private-use TLD.
  'arpa',
  'internal',
]);

export function isReservedMailDomain(domain: string): boolean {
  return RESERVED_MAIL_DOMAINS.some(reserved => domain === reserved || domain.endsWith(`.${reserved}`));
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

export interface MailExchangeRecord {
  readonly exchange: string;
  readonly priority: number;
}

/**
 * What the check asks DNS. `node:dns/promises`'s `Resolver` satisfies it in production
 * (`apps/worker/src/handlers/routeValidate.ts`); a test hands in a table.
 *
 * A failure is an `Error` carrying Node's resolver `code`: `ENOTFOUND` is NXDOMAIN,
 * `ENODATA` is a name that exists with no record of the type, and everything else —
 * `ETIMEOUT`, `ESERVFAIL`, `EREFUSED`, `ECONNREFUSED` and the rest — is no answer.
 */
export interface MailDomainResolver {
  resolveMx(domain: string): Promise<readonly MailExchangeRecord[]>;
  resolve4(domain: string): Promise<readonly string[]>;
  resolve6(domain: string): Promise<readonly string[]>;
}

export type DnsLookup<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/** A lookup that takes longer than this is no answer. The resolver's own timeouts are shorter. */
export const DNS_LOOKUP_DEADLINE_MILLISECONDS = 5_000;

async function lookup<T>(run: () => Promise<T>, deadlineMilliseconds: number): Promise<DnsLookup<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DnsLookup<T>>(resolve => {
    timer = setTimeout(() => {
      resolve({ ok: false, code: 'ETIMEOUT' });
    }, deadlineMilliseconds);
  });
  try {
    return await Promise.race([
      run().then(
        (value): DnsLookup<T> => ({ ok: true, value }),
        (error: unknown): DnsLookup<T> => ({ ok: false, code: errorCode(error) }),
      ),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { readonly code: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'EUNKNOWN';
}

/** A resolver error that is an answer: the name does not exist, or has no such record. */
function isDefiniteAbsence(code: string): boolean {
  return code === 'ENOTFOUND' || code === 'ENODATA';
}

function deferredFor(code: string): EmailValidationVerdict {
  if (code === 'ETIMEOUT') return { verdict: 'deferred', reason: 'dns_timeout' };
  if (code === 'ESERVFAIL') return { verdict: 'deferred', reason: 'dns_servfail' };
  if (code === 'EREFUSED' || code === 'ECONNREFUSED') return { verdict: 'deferred', reason: 'dns_refused' };
  return { verdict: 'deferred', reason: 'dns_error' };
}

/**
 * What an MX answer says, or null when it says "ask for the address records".
 *
 * RFC 7505's null MX is an exchange of `.`, which Node reports as the empty string. A
 * domain whose every MX is null has said it takes no mail; one that mixes a null MX with
 * a real one is misconfigured and is judged by the real one.
 */
export function mxVerdict(mx: DnsLookup<readonly MailExchangeRecord[]>): EmailValidationVerdict | null {
  if (mx.ok) {
    const real = mx.value.filter(record => record.exchange !== '' && record.exchange !== '.');
    if (real.length > 0) return { verdict: 'passed', reason: 'mx_present' };
    if (mx.value.length > 0) return { verdict: 'failed', reason: 'null_mx' };
    return null;
  }
  if (mx.code === 'ENOTFOUND') return { verdict: 'failed', reason: 'domain_not_found' };
  if (mx.code === 'ENODATA') return null;
  return deferredFor(mx.code);
}

/**
 * RFC 5321 5.1: with no MX, "the domain is to be treated as if it had an MX with the
 * domain itself as the exchange". An address record is therefore a place mail can go,
 * and its absence — both families definitely absent — is `no_mail_host`. One family
 * absent and the other unanswered is no answer yet.
 */
export function implicitMxVerdict(a: DnsLookup<readonly string[]>, aaaa: DnsLookup<readonly string[]>): EmailValidationVerdict {
  if ((a.ok && a.value.length > 0) || (aaaa.ok && aaaa.value.length > 0)) {
    return { verdict: 'passed', reason: 'implicit_mx' };
  }
  const absent = (answer: DnsLookup<readonly string[]>): boolean =>
    answer.ok ? answer.value.length === 0 : isDefiniteAbsence(answer.code);
  if (absent(a) && absent(aaaa)) return { verdict: 'failed', reason: 'no_mail_host' };
  const unanswered = [a, aaaa].find(answer => !answer.ok && !isDefiniteAbsence(answer.code));
  return deferredFor(unanswered !== undefined && !unanswered.ok ? unanswered.code : 'EUNKNOWN');
}

/** Ask DNS whether mail can reach `domain`: MX first, then the implicit MX. */
export async function checkMailDomain(
  resolver: MailDomainResolver,
  domain: string,
  options: { readonly deadlineMilliseconds?: number | undefined } = {},
): Promise<EmailValidationVerdict> {
  const deadline = options.deadlineMilliseconds ?? DNS_LOOKUP_DEADLINE_MILLISECONDS;
  const byMx = mxVerdict(await lookup(async () => await resolver.resolveMx(domain), deadline));
  if (byMx !== null) return byMx;
  const [a, aaaa] = await Promise.all([
    lookup(async () => await resolver.resolve4(domain), deadline),
    lookup(async () => await resolver.resolve6(domain), deadline),
  ]);
  return implicitMxVerdict(a, aaaa);
}

/**
 * The whole of `email-validation.1` for one address, in the order of the table above:
 * the three checks that need no DNS, then DNS. `knownBadElsewhere` is asked only when
 * the syntax and the domain are sane, because a malformed address is malformed
 * whatever its twin did.
 */
export async function validateEmailAddress(
  address: string,
  options: {
    readonly resolver: MailDomainResolver;
    readonly knownBadElsewhere: () => Promise<boolean>;
    readonly deadlineMilliseconds?: number | undefined;
  },
): Promise<EmailValidationVerdict> {
  const parsed = parseEmailAddress(address);
  if (parsed === null) return { verdict: 'failed', reason: 'syntax_invalid' };
  if (isReservedMailDomain(parsed.domain)) return { verdict: 'failed', reason: 'domain_reserved' };
  if (await options.knownBadElsewhere()) return { verdict: 'failed', reason: 'known_bad_route' };
  return await checkMailDomain(options.resolver, parsed.domain, { deadlineMilliseconds: options.deadlineMilliseconds });
}

// ---------------------------------------------------------------------------
// Association: the confidence a passed address records when it has none
// ---------------------------------------------------------------------------

/** The sources that mean a member of the workspace entered the address themselves. */
export const MEMBER_ENTERED_SOURCES: readonly RouteSource[] = Object.freeze(['salesperson', 'import'] as const);

/** "The person who entered it vouched for it": g88's Confirm and the drill's own value. */
export const MEMBER_VOUCHED_CONFIDENCE = 1;

export function vouchedConfidenceFor(source: RouteSource): number | null {
  return MEMBER_ENTERED_SOURCES.includes(source) ? MEMBER_VOUCHED_CONFIDENCE : null;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface RouteValidationPayload {
  readonly routeKind: 'email';
  readonly routeId: string;
  readonly routeVersion: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The payload `emailValidationJob` writes, or null. Phone routes are not validated here. */
export function parseRouteValidationPayload(payload: Readonly<Record<string, unknown>>): RouteValidationPayload | null {
  const { routeKind, routeId, routeVersion } = payload;
  if (routeKind !== 'email') return null;
  if (typeof routeId !== 'string' || !UUID.test(routeId)) return null;
  if (typeof routeVersion !== 'number' || !Number.isInteger(routeVersion) || routeVersion < 1) return null;
  return { routeKind, routeId, routeVersion };
}

export type EmailValidationReport =
  | { readonly outcome: 'written'; readonly verdict: EmailValidationVerdict; readonly route: RouteRow }
  | { readonly outcome: 'deferred'; readonly verdict: EmailValidationVerdict }
  /** Nothing to do: the route is gone, at another version, or no longer an unchecked candidate. */
  | { readonly outcome: 'skipped'; readonly reason: string };

interface UncheckedRoute {
  readonly id: string;
  readonly firm_id: string;
  readonly address: string;
  readonly source: RouteSource;
  readonly version: number;
  readonly eligibility: string;
  readonly technical_validation: string;
  readonly [column: string]: unknown;
}

/**
 * Run one `route.validate` job (lane g90).
 *
 * DNS is asked **before** any lock is taken, so a slow resolver holds no row; the write
 * then re-reads the route under its lock and writes only if it is still the unchecked
 * candidate at the version the job names (`recordEmailRouteValidation`). A check that
 * got no answer writes nothing to the route — a `usable` route is never lowered and an
 * `unknown` one stays `unknown` — and leaves an audit event saying why, so an operator
 * can tell a resolver that is failing from a queue that is not running. The sweep asks
 * again later.
 */
export async function runEmailRouteValidation(
  context: RepositoryContext,
  input: {
    readonly payload: RouteValidationPayload;
    readonly resolver: MailDomainResolver;
    readonly deadlineMilliseconds?: number | undefined;
  },
): Promise<EmailValidationReport> {
  const { payload } = input;
  const { rows } = await context.db.query<UncheckedRoute>(
    `SELECT id, firm_id, address, source, version, eligibility, technical_validation
       FROM email_addresses WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, payload.routeId],
  );
  const route = rows[0];
  if (route === undefined) return { outcome: 'skipped', reason: 'route_unknown' };
  if (
    Number(route.version) !== payload.routeVersion ||
    route.eligibility !== 'candidate' ||
    route.technical_validation !== 'unknown'
  ) {
    return { outcome: 'skipped', reason: 'superseded' };
  }

  const verdict = await validateEmailAddress(route.address, {
    resolver: input.resolver,
    knownBadElsewhere: async () => await addressFailedElsewhere(context, route.address, route.id),
    deadlineMilliseconds: input.deadlineMilliseconds,
  });

  if (verdict.verdict === 'deferred') {
    await recordCrmAuditEvent(context, {
      action: 'route.email.validation_deferred',
      subjectKind: 'route',
      subjectId: route.id,
      detail: {
        firmId: route.firm_id,
        reason: verdict.reason,
        ruleVersion: EMAIL_VALIDATION_RULE_VERSION,
        version: Number(route.version),
      },
    });
    return { outcome: 'deferred', verdict };
  }

  const written = await recordEmailRouteValidation(context, {
    routeId: route.id,
    routeVersion: payload.routeVersion,
    technicalValidation: verdict.verdict,
    vouchedConfidence: vouchedConfidenceFor(route.source),
    detail: { ruleVersion: EMAIL_VALIDATION_RULE_VERSION, reason: verdict.reason },
  });
  if (!written.written) return { outcome: 'skipped', reason: written.reason };
  return { outcome: 'written', verdict, route: written.route };
}

/**
 * Whether another route in this workspace with the same address has failed validation.
 *
 * *Failed*, not merely retired: a retirement says an address does not reach *that*
 * firm or person (9.1's "wrong number"), which is an association fact, and an address
 * moved from a firm-level route to a contact-level one would otherwise be invalid for
 * ever. A bounce (12.4) and this check both write `failed`, and a route retired after
 * failing keeps it, so this is every address the workspace has seen mail not reach.
 * `email_addresses_by_address` serves it.
 */
async function addressFailedElsewhere(context: RepositoryContext, address: string, routeId: string): Promise<boolean> {
  const { rows } = await context.db.query(
    `SELECT 1 FROM email_addresses
      WHERE workspace_id = $1 AND address = $2 AND id <> $3 AND technical_validation = 'failed'
      LIMIT 1`,
    [context.scope.workspaceId, address, routeId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/** A route unchecked this long after its last change is the sweep's to ask about. */
export const EMAIL_VALIDATION_SWEEP_AFTER_MINUTES = 10;
/** Routes the sweep enqueues per scheduler pass, across every workspace. */
export const EMAIL_VALIDATION_SWEEP_LIMIT = 20;

/**
 * The two rounds a sweep at `now` may use: one per UTC hour for a route changed within
 * the last day, then one per UTC day. So an address whose domain's DNS keeps failing is
 * asked about hourly for its first day and daily after that, and never twice in a round.
 */
export function emailValidationSweepRounds(now: string): { readonly hourly: string; readonly daily: string } {
  const instant = new Date(now);
  if (Number.isNaN(instant.getTime())) throw new RangeError('a sweep round is derived from a real instant');
  const iso = instant.toISOString();
  return { hourly: `sweep-${iso.slice(0, 13)}`, daily: `sweep-${iso.slice(0, 10)}` };
}

export interface EmailRouteDueForValidation {
  readonly workspaceId: string;
  readonly routeId: string;
  readonly routeVersion: number;
  readonly round: string;
}

/**
 * The unchecked email routes the sweep should ask about at `now` (13.1: indexed
 * queries, no external action).
 *
 * A `candidate` with `technical_validation = 'unknown'` at an active firm, unchanged for
 * `afterMinutes`, with no job for its round yet and no creation job still waiting. The
 * two job lookups are equality on `jobs_idempotent`, so a route already asked about this
 * round costs an index probe and never a slot in the limit: the limit is spent on routes
 * that need asking, oldest first, and none of them starves behind the ones that were
 * asked.
 *
 * The route scan itself has no partial index to use, because adding one is a migration
 * and this lane has none; at one workspace's size it is a sequential scan of one table a
 * minute. `docs/decisions/g90-email-technical-validation.md` names the index to add.
 */
export async function listEmailRoutesDueForValidation(
  db: Queryable,
  input: { readonly now: string; readonly afterMinutes?: number | undefined; readonly limit?: number | undefined },
): Promise<readonly EmailRouteDueForValidation[]> {
  const rounds = emailValidationSweepRounds(input.now);
  const { rows } = await db.query<{ workspace_id: string; id: string; version: number; round: string }>(
    `SELECT a.workspace_id, a.id, a.version, due.round
       FROM email_addresses a
       JOIN firms f ON f.workspace_id = a.workspace_id AND f.id = a.firm_id AND f.status = 'active'
      CROSS JOIN LATERAL (
            SELECT CASE WHEN a.updated_at > $1::timestamptz - interval '1 day' THEN $4 ELSE $5 END AS round
           ) AS due
      WHERE a.eligibility = 'candidate'
        AND a.technical_validation = 'unknown'
        AND a.updated_at <= $1::timestamptz - make_interval(mins => $2::integer)
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.workspace_id = a.workspace_id
                 AND j.kind = 'route.validate'
                 AND (j.idempotency_key = 'route-validate:' || a.id::text || ':' || a.version::text || ':' || due.round
                      OR (j.idempotency_key = 'route-validate:' || a.id::text || ':' || a.version::text || ':' || $6
                          AND j.state IN ('queued', 'running', 'retryable')))
            )
      ORDER BY a.updated_at, a.id
      LIMIT $3`,
    [
      input.now,
      Math.trunc(input.afterMinutes ?? EMAIL_VALIDATION_SWEEP_AFTER_MINUTES),
      Math.trunc(input.limit ?? EMAIL_VALIDATION_SWEEP_LIMIT),
      rounds.hourly,
      rounds.daily,
      EMAIL_VALIDATION_ROUND_NEW,
    ],
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    routeId: row.id,
    routeVersion: Number(row.version),
    round: row.round,
  }));
}

/** The jobs `listEmailRoutesDueForValidation` asks for, keyed by `emailValidationJob`. */
export async function emailValidationSweep(
  db: Queryable,
  input: { readonly now: string; readonly afterMinutes?: number | undefined; readonly limit?: number | undefined },
): Promise<ReturnType<typeof emailValidationJob>[]> {
  const due = await listEmailRoutesDueForValidation(db, input);
  return due.map(route => emailValidationJob(route.workspaceId, route.routeId, route.routeVersion, route.round));
}

/** A person's "Check again" round: one per command, and short enough for any command id. */
export function emailValidationCheckRound(commandId: string): string {
  return `check-${createHash('sha256').update(commandId).digest('hex').slice(0, 32)}`;
}

export interface RequestEmailValidationInput {
  readonly routeId: string;
  /** The version the person was looking at. */
  readonly routeVersion: number;
  /** The command's id: one job per press, and a replayed press is the same job. */
  readonly commandId: string;
}

export interface EmailValidationRequested {
  readonly routeId: string;
  readonly routeVersion: number;
  /** False when there was nothing to check: the address is already usable, or already passed. */
  readonly queued: boolean;
}

/**
 * "Check again" (lane g90): one more `route.validate` job for an address that is still
 * being checked.
 *
 * Lock, then decide, then write, like every CRM command: the firm's row lock and
 * `decideFirmMutation`, so a salesperson asks only about their own firms. What it writes
 * is a job and an audit event, never the route — the worker's answer is what changes the
 * route, through the same compare-and-set as every other check.
 *
 * Refusals are the route's own: gone (`route_unknown`), retired, changed since the page
 * was drawn (`route_version_stale`), or failed (`route_invalid` — a definite answer is a
 * new retrieval, not a retry; add the right address instead). An address that is already
 * usable, or passed and waiting on association, is answered as it is with nothing queued.
 */
export async function requestEmailRouteValidation(
  context: RepositoryContext,
  input: RequestEmailValidationInput,
): Promise<CrmResult<EmailValidationRequested>> {
  const { rows } = await context.db.query<UncheckedRoute>(
    `SELECT id, firm_id, address, source, version, eligibility, technical_validation
       FROM email_addresses WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, input.routeId],
  );
  const route = rows[0];
  if (route === undefined) return refuse('route_unknown');
  const firm = await loadFirmForUpdate(context, route.firm_id);
  if (firm === null) return refuse('firm_unknown');
  const decision = decideFirmMutation(context, firm);
  if (!decision.permitted) return refuse(decision.reason);
  if (route.eligibility === 'retired') return refuse('route_retired');
  if (Number(route.version) !== input.routeVersion) return refuse('route_version_stale');
  if (route.eligibility === 'invalid' || route.technical_validation === 'failed') return refuse('route_invalid');

  const answer = { routeId: route.id, routeVersion: Number(route.version) };
  if (route.eligibility !== 'candidate' || route.technical_validation !== 'unknown') {
    return accept({ ...answer, queued: false });
  }
  const job = await enqueueJob(
    context.db,
    emailValidationJob(context.scope.workspaceId, route.id, Number(route.version), emailValidationCheckRound(input.commandId)),
  );
  await recordCrmAuditEvent(context, {
    action: 'route.email.check_requested',
    subjectKind: 'route',
    subjectId: route.id,
    detail: { firmId: route.firm_id, version: Number(route.version), jobId: job.jobId },
  });
  return accept({ ...answer, queued: true });
}
