import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db';
import { HandlerRegistry, jobIdempotencyKey, runTwiceUnderStolenLease } from '@fss/domain/jobs';
import {
  EMAIL_VALIDATION_SWEEP_LIMIT,
  addEmailRoute,
  type MailDomainResolver,
  type MailExchangeRecord,
} from '@fss/domain/crm';
import { runClaimedJob, runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import { routeValidateJobHandler, routeValidationSource } from '../src/handlers/routeValidate.ts';

/**
 * The `route.validate` job as the worker runs it (specification 7.4, 13.1, 13.2,
 * Appendix G 2; lane g90).
 *
 * What is proved here and nowhere else: the registry takes the handler under the
 * protection `jobKinds.ts` names; the job an added address enqueues is claimed and
 * decides the route through the real runner; an unanswered check leaves the route
 * `unknown` and the one-minute pass asks again — once a round, oldest first, bounded,
 * and never for a route whose creation check is still waiting; and one business effect
 * under a real stolen lease.
 *
 * ## The vacuous-pass traps, named
 *
 * **A route usable from the start.** Every address is added as the Mac adds one — no
 * validation, no confidence — and is required to be an unchecked candidate before the
 * job runs.
 *
 * **A sweep that finds the same routes every pass.** The bound test makes more unchecked
 * routes than one pass may enqueue and requires the second pass to take the *next* ones;
 * a sweep that re-selected routes it had already asked about this round would enqueue
 * nothing the second time and fail.
 *
 * **A resolver that answers everything.** The fake is a table; a domain it does not know
 * throws, and the table is swapped between runs so a re-check is seen to ask again.
 *
 * Domains are under `.fsstest`, a top-level name that does not exist.
 */

type Answer<T> = T | { readonly code: string };
interface DomainAnswers {
  readonly mx?: Answer<readonly MailExchangeRecord[]>;
  readonly a?: Answer<readonly string[]>;
  readonly aaaa?: Answer<readonly string[]>;
}

const NODATA = { code: 'ENODATA' } as const;

/** A resolver whose answers can be changed between runs, with a log of what was asked. */
function tableResolver(): MailDomainResolver & {
  table: Record<string, DomainAnswers>;
  readonly asked: string[];
} {
  const state = {
    table: {} as Record<string, DomainAnswers>,
    asked: [] as string[],
  };
  const answer = async <T>(kind: keyof DomainAnswers, domain: string): Promise<T> => {
    state.asked.push(`${kind}:${domain}`);
    const entry = state.table[domain];
    if (entry === undefined) throw new Error(`the fake resolver was asked about ${domain}, which no case expects`);
    const value = entry[kind] ?? NODATA;
    if (typeof value === 'object' && value !== null && 'code' in value) {
      throw Object.assign(new Error(`${kind} ${domain}: ${value.code}`), { code: value.code });
    }
    return await Promise.resolve(value as T);
  };
  return Object.assign(state, {
    resolveMx: async (domain: string) => await answer<readonly MailExchangeRecord[]>('mx', domain),
    resolve4: async (domain: string) => await answer<readonly string[]>('a', domain),
    resolve6: async (domain: string) => await answer<readonly string[]>('aaaa', domain),
  });
}

describe('route.validate: the job, the sweep and a stolen lease', () => {
  let database: TestDatabase;
  let workspaceId = '';
  let firmId = '';
  let mergedFirmId = '';
  let contactId = '';
  let serial = 0;
  const resolver = tableResolver();

  const system = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);

  const one = async (sql: string, values: readonly unknown[] = []): Promise<string> => {
    const { rows } = await database.session.query<{ id: string }>(sql, values);
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`the fixture returned no row: ${sql.slice(0, 60)}`);
    return id;
  };

  /**
   * An instant the sweep reasons about: `offsetMinutes` after `anchor` in database time.
   * `hour` is twenty minutes into the next UTC hour and `day` one hour into the day after
   * tomorrow, so a case's passes a minute apart share a round whatever the clock says.
   */
  const at = async (anchor: 'now' | 'hour' | 'day', offsetMinutes = 0): Promise<string> => {
    const base = {
      now: 'now()',
      hour: "date_trunc('hour', now()) + interval '80 minutes'",
      day: "date_trunc('day', now()) + interval '2 days 1 hour'",
    }[anchor];
    const { rows } = await database.session.query<{ now: Date }>(
      `SELECT ${base} + make_interval(mins => $1::integer) AS now`,
      [offsetMinutes],
    );
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('the database returned no clock');
    return now.toISOString();
  };

  /** An address the way Import adds one: `import`, no validation, no confidence. */
  const imported = async (domain: string, firm = firmId) => {
    serial += 1;
    const added = await addEmailRoute(system(), {
      firmId: firm,
      ...(firm === firmId ? { contactId } : {}),
      address: `person${String(serial)}@${domain}`,
      source: 'import',
    });
    if (!added.ok) throw new Error(`the route fixture was refused: ${added.reason}`);
    expect(added.value.eligibility).toBe('candidate');
    expect(added.value.technical_validation).toBe('unknown');
    return added.value;
  };

  const route = async (id: string) =>
    (
      await database.session.query<{
        technical_validation: string;
        eligibility: string;
        version: number;
        association_confidence: string | null;
      }>(
        `SELECT technical_validation, eligibility, version, association_confidence
           FROM email_addresses WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, id],
      )
    ).rows[0];

  const registry = () => new HandlerRegistry().register(routeValidateJobHandler({ resolver }));

  const runJobs = async () => await runOnce(database.session, { registry: registry(), owner: 'g90-test', limit: 100 });

  const sweep = async (anchor: 'now' | 'hour' | 'day', offsetMinutes = 0) =>
    await runSchedulerPass(database.session, { sources: [routeValidationSource()], now: await at(anchor, offsetMinutes) });

  const queuedKeys = async (): Promise<string[]> =>
    (
      await database.session.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM jobs WHERE workspace_id = $1 AND kind = 'route.validate' AND state = 'queued' ORDER BY idempotency_key",
        [workspaceId],
      )
    ).rows.map(row => row.idempotency_key);

  beforeAll(async () => {
    database = await createTestDatabase();
    workspaceId = await one("INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id");
    firmId = await one(
      `INSERT INTO firms (workspace_id, name, region_code, postal_code, time_zone, time_zone_confidence,
                          time_zone_source, time_zone_rule_version)
       VALUES ($1, 'Northwind Test Holdings', 'RI', '02903', 'America/New_York', 'high', 'postal', 'firm-zone.1')
       RETURNING id`,
      [workspaceId],
    );
    mergedFirmId = await one(
      "INSERT INTO firms (workspace_id, name) VALUES ($1, 'Northwind Test Holdings (old)') RETURNING id",
      [workspaceId],
    );
    contactId = await one(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Dana Example') RETURNING id",
      [workspaceId, firmId],
    );
  });

  beforeEach(async () => {
    // Each case starts with an empty route.validate queue, so the claims below are the
    // case's own jobs and the sweep's counts are the case's own routes.
    await database.session.query("DELETE FROM jobs WHERE kind = 'route.validate'");
    await database.session.query(
      "UPDATE email_addresses SET eligibility = 'retired', retired_at = now(), retired_reason = 'between cases', version = version + 1 WHERE workspace_id = $1 AND eligibility = 'candidate'",
      [workspaceId],
    );
    resolver.table = {};
    resolver.asked.length = 0;
  });

  afterAll(async () => {
    await database.drop();
  });

  it('registers under the protection jobKinds.ts names, and refuses any other', () => {
    expect(registry().get('route.validate')?.protection).toBe('business_uniqueness');
    expect(() =>
      new HandlerRegistry().register({ ...routeValidateJobHandler({ resolver }), protection: 'fencing_token' }),
    ).toThrow(/business_uniqueness/);
  });

  it('decides an imported address from its MX, its implicit MX, or its absence', async () => {
    resolver.table = {
      'mx.fsstest': { mx: [{ exchange: 'mail.mx.fsstest', priority: 10 }] },
      'aonly.fsstest': { mx: NODATA, a: ['192.0.2.10'], aaaa: NODATA },
      'gone.fsstest': { mx: { code: 'ENOTFOUND' } },
    };
    const withMx = await imported('mx.fsstest');
    const aOnly = await imported('aonly.fsstest');
    const gone = await imported('gone.fsstest');

    const run = await runJobs();
    expect(run).toMatchObject({ claimed: 3, completed: 3, failed: 0 });
    expect(await route(withMx.id)).toEqual({
      technical_validation: 'passed',
      eligibility: 'usable',
      version: 2,
      association_confidence: '1.000',
    });
    expect(await route(aOnly.id)).toMatchObject({ technical_validation: 'passed', eligibility: 'usable', version: 2 });
    expect(await route(gone.id)).toEqual({
      technical_validation: 'failed',
      eligibility: 'invalid',
      version: 2,
      association_confidence: null,
    });
    // Nothing left to claim: every answer completed its job.
    expect((await runJobs()).claimed).toBe(0);
  });

  it('leaves a timed-out address unknown, completes the job, and the sweep asks again later', async () => {
    resolver.table = { 'slow.fsstest': { mx: { code: 'ETIMEOUT' } } };
    const slow = await imported('slow.fsstest');
    const first = await runJobs();
    expect(first).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await route(slow.id)).toEqual({
      technical_validation: 'unknown',
      eligibility: 'candidate',
      version: 1,
      association_confidence: null,
    });

    // Too soon: the sweep waits ten minutes after the route's last change.
    expect((await sweep('now', 5)).inserted).toBe(0);

    const later = await sweep('hour');
    expect(later.outcome).toBe('ran');
    expect(later.externalActions).toBe(0);
    expect(later.inserted).toBe(1);
    const due = await at('hour');
    expect(await queuedKeys()).toEqual([jobIdempotencyKey.routeValidate(slow.id, 1, `sweep-${due.slice(0, 13)}`)]);
    // The same round again asks for nothing more.
    expect((await sweep('hour', 1)).inserted).toBe(0);

    resolver.table = { 'slow.fsstest': { mx: [{ exchange: 'mail.slow.fsstest', priority: 10 }] } };
    expect(await runJobs()).toMatchObject({ claimed: 1, completed: 1 });
    expect(await route(slow.id)).toMatchObject({ technical_validation: 'passed', eligibility: 'usable', version: 2 });
    expect(resolver.asked.filter(entry => entry === 'mx:slow.fsstest')).toHaveLength(2);
    // Checked now: the sweep has nothing to ask about it in any later round.
    expect((await sweep('day')).inserted).toBe(0);
  });

  it('asks hourly for a route changed in the last day, then daily', async () => {
    resolver.table = { 'broken.fsstest': { mx: { code: 'ESERVFAIL' } } };
    const broken = await imported('broken.fsstest');
    expect(await runJobs()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect((await sweep('hour')).inserted).toBe(1);
    const hour = await at('hour');
    expect(await queuedKeys()).toEqual([jobIdempotencyKey.routeValidate(broken.id, 1, `sweep-${hour.slice(0, 13)}`)]);
    expect(await runJobs()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    const day = await at('day');
    expect((await sweep('day')).inserted).toBe(1);
    expect(await queuedKeys()).toEqual([jobIdempotencyKey.routeValidate(broken.id, 1, `sweep-${day.slice(0, 10)}`)]);
    // Another hour the same day is the same daily round.
    expect((await sweep('day', 60)).inserted).toBe(0);
    expect(await route(broken.id)).toMatchObject({ technical_validation: 'unknown', eligibility: 'candidate', version: 1 });
  });

  it('bounds a pass, takes the next routes on the next pass, and skips what it must not ask about', async () => {
    resolver.table = { 'mx.fsstest': { mx: [{ exchange: 'mail.mx.fsstest', priority: 10 }] } };
    const many = [];
    for (let index = 0; index < EMAIL_VALIDATION_SWEEP_LIMIT + 5; index += 1) many.push(await imported('mx.fsstest'));
    // Their creation checks ran and got no answer, as a resolver outage would leave them.
    await database.session.query("UPDATE jobs SET state = 'done', completed_at = now() WHERE kind = 'route.validate'");

    // A route whose creation check is still waiting is not asked about twice.
    const waiting = await imported('mx.fsstest');
    // A route left at a merged firm is history, not work.
    const atMergedFirm = await imported('mx.fsstest', mergedFirmId);
    await database.session.query(
      "UPDATE jobs SET state = 'done', completed_at = now() WHERE kind = 'route.validate' AND payload ->> 'routeId' = $1",
      [atMergedFirm.id],
    );
    await database.session.query("UPDATE firms SET status = 'merged', merged_into_firm_id = $2 WHERE workspace_id = $1 AND id = $3", [
      workspaceId,
      firmId,
      mergedFirmId,
    ]);

    const first = await sweep('hour');
    expect(first.inserted).toBe(EMAIL_VALIDATION_SWEEP_LIMIT);
    const second = await sweep('hour', 1);
    expect(second.inserted).toBe(5);
    expect((await sweep('hour', 2)).inserted).toBe(0);

    const { rows } = await database.session.query<{ route_id: string }>(
      `SELECT payload ->> 'routeId' AS route_id FROM jobs
        WHERE workspace_id = $1 AND kind = 'route.validate' AND idempotency_key LIKE '%:sweep-%'`,
      [workspaceId],
    );
    const swept = new Set(rows.map(row => row.route_id));
    expect(swept.size).toBe(EMAIL_VALIDATION_SWEEP_LIMIT + 5);
    for (const entry of many) expect(swept.has(entry.id)).toBe(true);
    expect(swept.has(waiting.id)).toBe(false);
    expect(swept.has(atMergedFirm.id)).toBe(false);
  });

  it('has one business effect under a stolen lease', async () => {
    resolver.table = { 'mx.fsstest': { mx: [{ exchange: 'mail.mx.fsstest', priority: 10 }] } };
    const target = await imported('mx.fsstest');
    // The probe enqueues its own job; the creation job would otherwise be claimed first.
    await database.session.query("DELETE FROM jobs WHERE kind = 'route.validate'");
    const validated = async (): Promise<number> => {
      const { rows } = await database.session.query<{ count: string }>(
        "SELECT count(*) AS count FROM audit_events WHERE workspace_id = $1 AND action = 'route.email.validated' AND subject_id = $2",
        [workspaceId, target.id],
      );
      return Number(rows[0]?.count ?? '0');
    };

    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry: registry(),
      run: runClaimedJob,
      workspaceId,
      kind: 'route.validate',
      idempotencyKey: jobIdempotencyKey.routeValidate(target.id, 1, 'probe'),
      payload: { routeKind: 'email', routeId: target.id, routeVersion: 1 },
      countEffects: validated,
    });
    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    expect(report.freshFencingToken).not.toBe(report.staleFencingToken);
    expect(await route(target.id)).toMatchObject({ eligibility: 'usable', version: 2 });
  });

  it('fails a payload it cannot read rather than guessing, and a phone payload is one', async () => {
    const handler = routeValidateJobHandler({ resolver });
    const job = {
      id: '00000000-0000-4000-8000-000000000000',
      workspaceId,
      kind: 'route.validate',
      idempotencyKey: 'route-validate:x:1:new',
      attempt: 1,
      maxAttempts: 4,
      fencingToken: '1',
      leaseOwner: 'test',
      leaseExpiresAt: new Date().toISOString(),
    };
    for (const payload of [{}, { routeKind: 'phone', routeId: firmId, routeVersion: 1 }]) {
      await expect(
        handler.handle({ session: database.session, scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), job: { ...job, payload } }),
      ).rejects.toThrow(/payload/);
    }
  });
});
