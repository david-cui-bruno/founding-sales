import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { ROUTE_ELIGIBILITY_POLICY_VERSION } from '../../crm/routePolicy.ts';
import {
  checkMailDomain,
  emailValidationCheckRound,
  emailValidationSweepRounds,
  implicitMxVerdict,
  isReservedMailDomain,
  mxVerdict,
  parseEmailAddress,
  parseRouteValidationPayload,
  runEmailRouteValidation,
  validateEmailAddress,
  vouchedConfidenceFor,
  type MailDomainResolver,
  type MailExchangeRecord,
} from '../../crm/routeValidation.ts';
import { addEmailRoute, addPhoneRoute, recordEmailRouteValidation, retireRoute } from '../../crm/routes.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

/**
 * Email technical validation (specification 7.4): the decision table of
 * `email-validation.1`, and the one write it makes.
 *
 * Before g90 an address added or imported from the Mac was `unknown` and `candidate` for
 * ever, and once sending opens every email step to it holds as `route_candidate`.
 *
 * ## The vacuous-pass traps, named
 *
 * **A route that was usable already.** An address added as `salesperson` with a passed
 * validation and a confidence is usable the moment it is added, so a test built on one
 * passes with no check at all. Every address here is added the way the Mac adds one —
 * no validation, no confidence — and each case begins by requiring it to be an unchecked
 * candidate.
 *
 * **A fake that answers everything.** The resolver is a table with a call log. A domain
 * that is not in it throws, so a check that asked DNS for something it should have
 * refused first — a malformed address, a reserved name — fails loudly rather than
 * quietly passing on a default.
 *
 * Domains are under `.fsstest`, a top-level name that does not exist, so none of them is
 * a real business and none is on the reserved list the check refuses without asking.
 */

type Answer<T> = T | { readonly code: string };

interface DomainAnswers {
  readonly mx?: Answer<readonly MailExchangeRecord[]>;
  readonly a?: Answer<readonly string[]>;
  readonly aaaa?: Answer<readonly string[]>;
}

const NODATA = { code: 'ENODATA' } as const;
const NXDOMAIN = { code: 'ENOTFOUND' } as const;
const TIMEOUT = { code: 'ETIMEOUT' } as const;
const SERVFAIL = { code: 'ESERVFAIL' } as const;

function fakeResolver(table: Readonly<Record<string, DomainAnswers>>): MailDomainResolver & { readonly asked: string[] } {
  const asked: string[] = [];
  const answer = async <T>(kind: keyof DomainAnswers, domain: string): Promise<T> => {
    asked.push(`${kind}:${domain}`);
    const entry = table[domain];
    if (entry === undefined) throw new Error(`the fake resolver was asked about ${domain}, which no case expects`);
    const value = entry[kind] ?? NODATA;
    if (typeof value === 'object' && value !== null && 'code' in value) {
      throw Object.assign(new Error(`${kind} ${domain}: ${value.code}`), { code: value.code });
    }
    return await Promise.resolve(value as T);
  };
  return {
    asked,
    resolveMx: async domain => await answer<readonly MailExchangeRecord[]>('mx', domain),
    resolve4: async domain => await answer<readonly string[]>('a', domain),
    resolve6: async domain => await answer<readonly string[]>('aaaa', domain),
  };
}

const DNS: Readonly<Record<string, DomainAnswers>> = {
  'mx.fsstest': { mx: [{ exchange: 'mail.mx.fsstest', priority: 10 }] },
  'aonly.fsstest': { mx: NODATA, a: ['192.0.2.10'], aaaa: NODATA },
  'v6only.fsstest': { mx: NODATA, a: NODATA, aaaa: ['2001:db8::25'] },
  'gone.fsstest': { mx: NXDOMAIN },
  'nomail.fsstest': { mx: NODATA, a: NODATA, aaaa: NODATA },
  'nullmx.fsstest': { mx: [{ exchange: '', priority: 0 }] },
  'mixed.fsstest': { mx: [{ exchange: '', priority: 0 }, { exchange: 'mx2.mixed.fsstest', priority: 20 }] },
  'slow.fsstest': { mx: TIMEOUT },
  'broken.fsstest': { mx: SERVFAIL },
  'halfslow.fsstest': { mx: NODATA, a: NODATA, aaaa: TIMEOUT },
  'hang.fsstest': {},
};

const never = async (): Promise<boolean> => await Promise.resolve(false);

describe('email-validation.1: the decision table', () => {
  it('accepts a sane address and gives DNS its A-label domain', () => {
    expect(parseEmailAddress('dana.o+intake@mx.fsstest')).toEqual({ localPart: 'dana.o+intake', domain: 'mx.fsstest' });
    expect(parseEmailAddress('dana@bücher.fsstest')).toEqual({ localPart: 'dana', domain: 'xn--bcher-kva.fsstest' });
  });

  it.each([
    ['no local part', '@mx.fsstest'],
    ['two at signs', 'a@b@mx.fsstest'],
    ['a leading dot', '.dana@mx.fsstest'],
    ['consecutive dots', 'dana..o@mx.fsstest'],
    ['a quoted local part', '"dana o"@mx.fsstest'],
    ['a non-ASCII local part', 'daña@mx.fsstest'],
    ['a local part over 64', `${'a'.repeat(65)}@mx.fsstest`],
    ['an address over 254', `dana@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.fsstest`],
    ['an address literal', 'dana@[192.0.2.1]'],
    ['a single-label domain', 'dana@localhostish'],
    ['a trailing dot', 'dana@mx.fsstest.'],
    ['an underscore in a label', 'dana@mail_host.fsstest'],
    ['a hyphen at a label edge', 'dana@-mx.fsstest'],
    ['an all-numeric top level', 'dana@192.0.2.1'],
  ])('refuses %s', (_case, address) => {
    expect(parseEmailAddress(address)).toBeNull();
  });

  it('refuses the special-use names, and nothing that merely resembles one', () => {
    for (const domain of ['example.com', 'mail.example.org', 'firm.test', 'x.example', 'a.invalid', 'printer.local', 'x.onion', 'home.arpa', 'corp.internal', 'localhost']) {
      expect(isReservedMailDomain(domain), domain).toBe(true);
    }
    for (const domain of ['examplelaw.com', 'test-firm.fsstest', 'mx.fsstest', 'notexample.com']) {
      expect(isReservedMailDomain(domain), domain).toBe(false);
    }
  });

  it('reads an MX answer: a real exchange, a null MX, NXDOMAIN, no MX, and no answer', () => {
    expect(mxVerdict({ ok: true, value: [{ exchange: 'mx.fsstest', priority: 5 }] })).toEqual({ verdict: 'passed', reason: 'mx_present' });
    expect(mxVerdict({ ok: true, value: [{ exchange: '', priority: 0 }] })).toEqual({ verdict: 'failed', reason: 'null_mx' });
    expect(mxVerdict({ ok: true, value: [{ exchange: '.', priority: 0 }] })).toEqual({ verdict: 'failed', reason: 'null_mx' });
    expect(mxVerdict({ ok: false, code: 'ENOTFOUND' })).toEqual({ verdict: 'failed', reason: 'domain_not_found' });
    expect(mxVerdict({ ok: false, code: 'ENODATA' })).toBeNull();
    expect(mxVerdict({ ok: true, value: [] })).toBeNull();
    expect(mxVerdict({ ok: false, code: 'ETIMEOUT' })).toEqual({ verdict: 'deferred', reason: 'dns_timeout' });
    expect(mxVerdict({ ok: false, code: 'ESERVFAIL' })).toEqual({ verdict: 'deferred', reason: 'dns_servfail' });
    expect(mxVerdict({ ok: false, code: 'EREFUSED' })).toEqual({ verdict: 'deferred', reason: 'dns_refused' });
    expect(mxVerdict({ ok: false, code: 'EBADRESP' })).toEqual({ verdict: 'deferred', reason: 'dns_error' });
  });

  it('reads the implicit MX: either family is a mail host, both absent is none, one unanswered is no answer', () => {
    const none = { ok: false, code: 'ENODATA' } as const;
    expect(implicitMxVerdict({ ok: true, value: ['192.0.2.1'] }, none)).toEqual({ verdict: 'passed', reason: 'implicit_mx' });
    expect(implicitMxVerdict(none, { ok: true, value: ['2001:db8::1'] })).toEqual({ verdict: 'passed', reason: 'implicit_mx' });
    expect(implicitMxVerdict(none, { ok: false, code: 'ENOTFOUND' })).toEqual({ verdict: 'failed', reason: 'no_mail_host' });
    expect(implicitMxVerdict({ ok: true, value: [] }, none)).toEqual({ verdict: 'failed', reason: 'no_mail_host' });
    expect(implicitMxVerdict(none, { ok: false, code: 'ETIMEOUT' })).toEqual({ verdict: 'deferred', reason: 'dns_timeout' });
  });

  it.each([
    ['dana@mx.fsstest', { verdict: 'passed', reason: 'mx_present' }],
    ['dana@mixed.fsstest', { verdict: 'passed', reason: 'mx_present' }],
    ['dana@aonly.fsstest', { verdict: 'passed', reason: 'implicit_mx' }],
    ['dana@v6only.fsstest', { verdict: 'passed', reason: 'implicit_mx' }],
    ['dana@gone.fsstest', { verdict: 'failed', reason: 'domain_not_found' }],
    ['dana@nomail.fsstest', { verdict: 'failed', reason: 'no_mail_host' }],
    ['dana@nullmx.fsstest', { verdict: 'failed', reason: 'null_mx' }],
    ['dana@slow.fsstest', { verdict: 'deferred', reason: 'dns_timeout' }],
    ['dana@broken.fsstest', { verdict: 'deferred', reason: 'dns_servfail' }],
    ['dana@halfslow.fsstest', { verdict: 'deferred', reason: 'dns_timeout' }],
  ])('%s is %o', async (address, expected) => {
    const resolver = fakeResolver(DNS);
    expect(await validateEmailAddress(address, { resolver, knownBadElsewhere: never })).toEqual(expected);
  });

  it('refuses a malformed address, a reserved name and a known-bad twin without asking DNS', async () => {
    const resolver = fakeResolver(DNS);
    expect(await validateEmailAddress('dana..o@mx.fsstest', { resolver, knownBadElsewhere: never })).toEqual({
      verdict: 'failed',
      reason: 'syntax_invalid',
    });
    expect(await validateEmailAddress('dana@firm.example.com', { resolver, knownBadElsewhere: never })).toEqual({
      verdict: 'failed',
      reason: 'domain_reserved',
    });
    expect(
      await validateEmailAddress('dana@mx.fsstest', { resolver, knownBadElsewhere: async () => await Promise.resolve(true) }),
    ).toEqual({ verdict: 'failed', reason: 'known_bad_route' });
    expect(resolver.asked).toEqual([]);
  });

  it('answers a lookup that never returns as a timeout, not a failure', async () => {
    const hanging: MailDomainResolver = {
      resolveMx: async () => await new Promise<never>(() => undefined),
      resolve4: async () => await new Promise<never>(() => undefined),
      resolve6: async () => await new Promise<never>(() => undefined),
    };
    expect(await checkMailDomain(hanging, 'hang.fsstest', { deadlineMilliseconds: 20 })).toEqual({
      verdict: 'deferred',
      reason: 'dns_timeout',
    });
  });

  it('vouches for what a member entered, and for nothing a provider did not measure', () => {
    expect(vouchedConfidenceFor('salesperson')).toBe(1);
    expect(vouchedConfidenceFor('import')).toBe(1);
    expect(vouchedConfidenceFor('research_provider')).toBeNull();
    expect(vouchedConfidenceFor('website')).toBeNull();
    expect(vouchedConfidenceFor('reply')).toBeNull();
  });

  it('parses only the payload the job builder writes, and derives rounds the same way twice', () => {
    const routeId = '6f0a2b3c-4d5e-4f6a-8b9c-1d2e3f4a5b6c';
    expect(parseRouteValidationPayload({ routeKind: 'email', routeId, routeVersion: 2 })).toEqual({
      routeKind: 'email',
      routeId,
      routeVersion: 2,
    });
    expect(parseRouteValidationPayload({ routeKind: 'phone', routeId, routeVersion: 2 })).toBeNull();
    expect(parseRouteValidationPayload({ routeKind: 'email', routeId: 'x', routeVersion: 2 })).toBeNull();
    expect(parseRouteValidationPayload({ routeKind: 'email', routeId, routeVersion: 0 })).toBeNull();
    expect(emailValidationSweepRounds('2026-09-25T14:37:10.000Z')).toEqual({
      hourly: 'sweep-2026-09-25T14',
      daily: 'sweep-2026-09-25',
    });
    expect(emailValidationCheckRound('cmd-1')).toBe(emailValidationCheckRound('cmd-1'));
    expect(emailValidationCheckRound('cmd-1')).not.toBe(emailValidationCheckRound('cmd-2'));
    expect(emailValidationCheckRound('x'.repeat(128)).length).toBeLessThanOrEqual(38);
  });
});

describe('recording a validation on an unchecked address', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let serial = 0;

  const contextFor = (workspace: 'alpha' | 'beta', who: 'admin' | 'salesperson' | 'system'): RepositoryContext =>
    repositoryContext(
      workspaceScope(
        seeded[workspace].workspaceId,
        who === 'system'
          ? { kind: 'system', component: 'worker' }
          : { kind: 'user', userId: seeded[workspace][who].userId, role: who },
      ),
      database.session,
    );

  /** An address the way the Mac adds one: no validation, no confidence. */
  const unchecked = async (
    domain: string,
    source: 'salesperson' | 'import' | 'research_provider' | 'website' = 'import',
    associationConfidence?: number,
  ) => {
    serial += 1;
    const added = await addEmailRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      address: `person${String(serial)}@${domain}`,
      source,
      ...(associationConfidence === undefined ? {} : { associationConfidence }),
    });
    if (!added.ok) throw new Error(`the route fixture was refused: ${added.reason}`);
    expect(added.value.eligibility).toBe('candidate');
    expect(added.value.technical_validation).toBe('unknown');
    expect(Number(added.value.version)).toBe(1);
    return { ...added.value, address: `person${String(serial)}@${domain}` };
  };

  const validate = async (route: { readonly id: string; readonly version: number }, domains = DNS) =>
    await runEmailRouteValidation(contextFor('alpha', 'system'), {
      payload: { routeKind: 'email', routeId: route.id, routeVersion: Number(route.version) },
      resolver: fakeResolver(domains),
    });

  const jobsFor = async (routeId: string) =>
    (
      await database.session.query<{ idempotency_key: string; payload: Record<string, unknown> }>(
        `SELECT idempotency_key, payload FROM jobs WHERE workspace_id = $1 AND kind = 'route.validate'
           AND payload ->> 'routeId' = $2 ORDER BY created_at`,
        [seeded.alpha.workspaceId, routeId],
      )
    ).rows;

  const audit = async (routeId: string, action: string) =>
    (
      await database.session.query<{ actor_kind: string; detail: Record<string, unknown> }>(
        `SELECT actor_kind, detail FROM audit_events WHERE workspace_id = $1 AND subject_id = $2 AND action = $3`,
        [seeded.alpha.workspaceId, routeId, action],
      )
    ).rows;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('enqueues one check when an unchecked address is added, and none for a number or a brought verdict', async () => {
    const route = await unchecked('mx.fsstest');
    expect(await jobsFor(route.id)).toEqual([
      {
        idempotency_key: `route-validate:${route.id}:1:new`,
        payload: { routeKind: 'email', routeId: route.id, routeVersion: 1 },
      },
    ]);

    const again = await addEmailRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      contactId: crm.alpha.contactId,
      address: route.address,
      source: 'import',
    });
    expect(again.ok && again.value.id).toBe(route.id);
    expect(await jobsFor(route.id)).toHaveLength(1);

    const brought = await addEmailRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      address: 'desk@mx.fsstest',
      source: 'salesperson',
      technicalValidation: 'passed',
      associationConfidence: 1,
    });
    expect(brought.ok && brought.value.eligibility).toBe('usable');
    if (brought.ok) expect(await jobsFor(brought.value.id)).toEqual([]);

    const phone = await addPhoneRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      e164: '+14015550131',
      source: 'import',
    });
    expect(phone.ok).toBe(true);
    const { rows } = await database.session.query(
      "SELECT 1 FROM jobs WHERE kind = 'route.validate' AND payload ->> 'routeId' = $1",
      [phone.ok ? phone.value.id : ''],
    );
    expect(rows).toEqual([]);
  });

  it.each([
    ['import', undefined, 'mx.fsstest', 'usable', 1, 'vouched'],
    ['salesperson', undefined, 'aonly.fsstest', 'usable', 1, 'vouched'],
    ['research_provider', undefined, 'mx.fsstest', 'candidate', null, 'none'],
    ['research_provider', 0.9, 'mx.fsstest', 'usable', 0.9, 'recorded'],
    ['website', 0.5, 'mx.fsstest', 'candidate', 0.5, 'recorded'],
  ] as const)(
    'a passed %s address with confidence %s becomes what route-policy.1 says',
    async (source, confidence, domain, eligibility, recorded, basis) => {
      const route = await unchecked(domain, source, confidence);
      const report = await validate(route);
      expect(report.outcome).toBe('written');
      if (report.outcome !== 'written') return;
      expect(report.route.technical_validation).toBe('passed');
      expect(report.route.eligibility).toBe(eligibility);
      expect(Number(report.route.version)).toBe(2);
      expect(report.route.association_confidence === null ? null : Number(report.route.association_confidence)).toBe(recorded);
      expect(report.route.eligibility_policy_version).toBe(eligibility === 'usable' ? ROUTE_ELIGIBILITY_POLICY_VERSION : null);
      expect(report.route.source).toBe(source);
      const events = await audit(route.id, 'route.email.validated');
      expect(events).toHaveLength(1);
      expect(events[0]?.actor_kind).toBe('worker');
      expect(events[0]?.detail).toMatchObject({
        ruleVersion: 'email-validation.1',
        technicalValidation: 'passed',
        eligibility,
        confidenceBasis: basis,
        fromVersion: 1,
        version: 2,
      });
      // The audit trail carries codes, never the address (5.2).
      expect(JSON.stringify(events[0]?.detail)).not.toContain('@');
    },
  );

  it.each([
    ['gone.fsstest', 'domain_not_found'],
    ['nomail.fsstest', 'no_mail_host'],
    ['nullmx.fsstest', 'null_mx'],
    ['firm.example.test', 'domain_reserved'],
  ])('a definite negative at %s makes the address invalid (%s), confidence untouched', async (domain, reason) => {
    const route = await unchecked(domain);
    const report = await validate(route);
    expect(report.outcome).toBe('written');
    if (report.outcome !== 'written') return;
    expect(report.route.technical_validation).toBe('failed');
    expect(report.route.eligibility).toBe('invalid');
    expect(report.route.association_confidence).toBeNull();
    expect(Number(report.route.version)).toBe(2);
    expect((await audit(route.id, 'route.email.validated'))[0]?.detail).toMatchObject({ reason, confidenceBasis: 'none' });
  });

  it('leaves an unanswered address unknown at its version, and says why in the audit trail', async () => {
    const route = await unchecked('slow.fsstest');
    const report = await validate(route);
    expect(report).toEqual({ outcome: 'deferred', verdict: { verdict: 'deferred', reason: 'dns_timeout' } });
    const { rows } = await database.session.query<{ technical_validation: string; eligibility: string; version: number }>(
      'SELECT technical_validation, eligibility, version FROM email_addresses WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, route.id],
    );
    expect(rows[0]).toEqual({ technical_validation: 'unknown', eligibility: 'candidate', version: 1 });
    expect(await audit(route.id, 'route.email.validation_deferred')).toEqual([
      { actor_kind: 'worker', detail: expect.objectContaining({ reason: 'dns_timeout', version: 1 }) as unknown },
    ]);
    expect(await audit(route.id, 'route.email.validated')).toEqual([]);
  });

  it('calls an address known-bad only when its twin failed, not merely when it was retired', async () => {
    const bounced = await unchecked('mx.fsstest');
    await database.session.query(
      `UPDATE email_addresses SET technical_validation = 'failed', eligibility = 'invalid', version = version + 1
        WHERE workspace_id = $1 AND id = $2`,
      [seeded.alpha.workspaceId, bounced.id],
    );
    const twin = await addEmailRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      address: bounced.address,
      source: 'import',
    });
    if (!twin.ok) throw new Error(twin.reason);
    const report = await validate(twin.value);
    expect(report.outcome === 'written' && report.route.eligibility).toBe('invalid');
    expect((await audit(twin.value.id, 'route.email.validated'))[0]?.detail).toMatchObject({ reason: 'known_bad_route' });

    // Retired as the wrong person's, then added where it belongs: an association fact,
    // not a deliverability one.
    const moved = await unchecked('mx.fsstest');
    const retired = await retireRoute(contextFor('alpha', 'salesperson'), {
      routeKind: 'email',
      routeId: moved.id,
      reason: 'Belongs to the firm, not to Dana',
    });
    expect(retired.ok).toBe(true);
    const firmLevel = await addEmailRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      address: moved.address,
      source: 'salesperson',
    });
    if (!firmLevel.ok) throw new Error(firmLevel.reason);
    const moveReport = await validate(firmLevel.value);
    expect(moveReport.outcome === 'written' && moveReport.route.eligibility).toBe('usable');
  });

  it('never touches a usable address, a moved version or another workspace’s address', async () => {
    const usable = await addEmailRoute(contextFor('alpha', 'salesperson'), {
      firmId: crm.alpha.firmId,
      address: 'desk2@mx.fsstest',
      source: 'salesperson',
      technicalValidation: 'passed',
      associationConfidence: 1,
    });
    if (!usable.ok) throw new Error(usable.reason);
    for (const domains of [{ ...DNS, 'mx.fsstest': { mx: NXDOMAIN } }, { ...DNS, 'mx.fsstest': { mx: TIMEOUT } }]) {
      expect(await validate(usable.value, domains)).toEqual({ outcome: 'skipped', reason: 'superseded' });
    }
    const direct = await recordEmailRouteValidation(contextFor('alpha', 'system'), {
      routeId: usable.value.id,
      routeVersion: 1,
      technicalValidation: 'failed',
      vouchedConfidence: null,
      detail: {},
    });
    expect(direct).toEqual({ written: false, reason: 'superseded' });
    const { rows } = await database.session.query<{ eligibility: string; version: number }>(
      'SELECT eligibility, version FROM email_addresses WHERE workspace_id = $1 AND id = $2',
      [seeded.alpha.workspaceId, usable.value.id],
    );
    expect(rows[0]).toEqual({ eligibility: 'usable', version: 1 });

    const route = await unchecked('mx.fsstest');
    expect(await validate({ id: route.id, version: 7 })).toEqual({ outcome: 'skipped', reason: 'superseded' });
    const first = await validate(route);
    expect(first.outcome).toBe('written');
    // The same job run again finds the route moved on.
    expect(await validate(route)).toEqual({ outcome: 'skipped', reason: 'superseded' });
    expect(await audit(route.id, 'route.email.validated')).toHaveLength(1);

    const elsewhere = await runEmailRouteValidation(contextFor('beta', 'system'), {
      payload: { routeKind: 'email', routeId: route.id, routeVersion: 1 },
      resolver: fakeResolver(DNS),
    });
    expect(elsewhere).toEqual({ outcome: 'skipped', reason: 'route_unknown' });
  });
});
