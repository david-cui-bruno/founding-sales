import { randomUUID } from 'node:crypto';
import { addFirmAcceptedSchema, importPreviewResponseSchema, importCommitResponseSchema, pluralFirmPageResponseSchema } from '@fss/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_ELIGIBILITY_POLICY_VERSION } from '@fss/domain/crm/routePolicy.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import type { MailDomainResolver, MailExchangeRecord } from '@fss/domain/crm/routeValidation.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { runSchedulerPass } from '../../worker/src/scheduler/schedulerPass.ts';
import { routeValidateJobHandler, routeValidationSource } from '../../worker/src/handlers/routeValidate.ts';
import { CLIENT_VERSION_UNDER_TEST, routeAnswer } from './support/routeThrough.ts';

/** Real API import/add → registered DNS worker → current route eligibility.
 * Fictional DNS covers success, a missing domain and retry after a transient failure.
 */
type Answer<T> = T | { readonly code: string };
interface DomainAnswers {
  readonly mx?: Answer<readonly MailExchangeRecord[]>;
  readonly a?: Answer<readonly string[]>;
  readonly aaaa?: Answer<readonly string[]>;
}

function tableResolver(table: Record<string, DomainAnswers>): MailDomainResolver {
  const answer = async <T>(kind: keyof DomainAnswers, domain: string): Promise<T> => {
    const entry = table[domain];
    if (entry === undefined) throw new Error(`the release check's resolver was asked about ${domain}`);
    const value = entry[kind] ?? { code: 'ENODATA' };
    if (typeof value === 'object' && value !== null && 'code' in value) {
      throw Object.assign(new Error(`${kind} ${domain}: ${value.code}`), { code: value.code });
    }
    return await Promise.resolve(value as T);
  };
  return {
    resolveMx: async domain => await answer<readonly MailExchangeRecord[]>('mx', domain),
    resolve4: async domain => await answer<readonly string[]>('a', domain),
    resolve6: async domain => await answer<readonly string[]>('aaaa', domain),
  };
}

describe('API and DNS worker route eligibility', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  const dns: Record<string, DomainAnswers> = {
    'harbor-law.fsstest': { mx: [{ exchange: 'mail.harbor-law.fsstest', priority: 10 }] },
    'nowhere-law.fsstest': { mx: { code: 'ENOTFOUND' } },
    'quiet-law.fsstest': { mx: { code: 'ETIMEOUT' } },
  };

  const post = async (path: string, body: Readonly<Record<string, unknown>>) =>
    await routeAnswer(fixture, 'POST', path, adminToken, body);
  const routesFor = async (firmId: string) => {
    const answer = await post('/crm/firm-page-v3', { firmId, pageVersion: 2 });
    expect(answer.status).toBe(200);
    const page = pluralFirmPageResponseSchema.parse(answer.body);
    if (page.visibility !== 'assigned_or_admin') throw new Error('fixture firm not visible');
    return page.read.visibility === 'assigned_or_admin' ? page.read.firm.emailRoutes : [];
  };
  const worker = async () =>
    await runOnce(fixture.db, {
      registry: new HandlerRegistry().register(routeValidateJobHandler({ resolver: tableResolver(dns) })),
      owner: 'release-check',
      limit: 20,
    });
  const address = async (value: string) =>
    (
      await fixture.db.query<{
        id: string;
        firm_id: string;
        source: string;
        technical_validation: string;
        eligibility: string;
        association_confidence: string | null;
        eligibility_policy_version: string | null;
        version: number;
      }>(
        `SELECT id, firm_id, source, technical_validation, eligibility, association_confidence,
                eligibility_policy_version, version
           FROM email_addresses WHERE workspace_id = $1 AND address = $2`,
        [fixture.alpha.workspaceId, value],
      )
    ).rows[0];

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('imports an address as an unchecked candidate, and the worker makes it usable', async () => {
    const csv = [
      'firm_name,website,contact_name,contact_email,region_code',
      'Harbor Test Law,harbor-law.fsstest,Kim Placeholder,kim@harbor-law.fsstest,RI',
      'Nowhere Test Law,nowhere-law.fsstest,Lee Placeholder,lee@nowhere-law.fsstest,RI',
    ].join('\n');
    const previewed = await post('/import/preview', { csv });
    expect(importPreviewResponseSchema.parse(previewed.body).counts).toMatchObject({ create: 2, invalid: 0 });
    const committed = await post('/import/commit', { csv, clientVersion: CLIENT_VERSION_UNDER_TEST,
      rows: [2, 3].map(rowNumber => ({ rowNumber, commandId: randomUUID() })) });
    expect(importCommitResponseSchema.parse(committed.body).results.map(result => result.status)).toEqual(['accepted', 'accepted']);

    const before = await address('kim@harbor-law.fsstest');
    expect(before).toMatchObject({ source: 'import', technical_validation: 'unknown', eligibility: 'candidate', version: 1 });
    expect(before?.association_confidence).toBeNull();
    expect((await address('lee@nowhere-law.fsstest'))?.eligibility).toBe('candidate');

    const run = await worker();
    expect(run).toMatchObject({ claimed: 2, completed: 2, failed: 0 });

    expect(await address('kim@harbor-law.fsstest')).toMatchObject({
      technical_validation: 'passed',
      eligibility: 'usable',
      association_confidence: '1.000',
      eligibility_policy_version: ROUTE_ELIGIBILITY_POLICY_VERSION,
      version: 2,
    });
    expect(await address('lee@nowhere-law.fsstest')).toMatchObject({
      technical_validation: 'failed',
      eligibility: 'invalid',
      association_confidence: null,
      version: 2,
    });

    const routes = await routesFor(before?.firm_id ?? '');
    expect(routes.map(entry => [entry.eligibility, entry.technicalValidation, entry.version])).toEqual([['usable', 'passed', 2]]);
  });

  it('keeps an unanswered address a candidate until the sweep asks again, and Check again queues one more', async () => {
    const added = await post('/crm/firms/add', {
      commandId: randomUUID(), clientVersion: CLIENT_VERSION_UNDER_TEST,
      firm: { name: 'Quiet Test Law', website: 'quiet-law.fsstest', timeZone: 'America/New_York' },
      contact: { fullName: 'Pat Placeholder', email: 'pat@quiet-law.fsstest' },
    });
    expect(added.status).toBe(200);
    addFirmAcceptedSchema.parse(added.body);
    expect(await worker()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const waiting = await address('pat@quiet-law.fsstest');
    expect(waiting).toMatchObject({ source: 'salesperson', technical_validation: 'unknown', eligibility: 'candidate', version: 1 });

    expect((await routesFor(waiting?.firm_id ?? ''))[0]).toMatchObject({ eligibility: 'candidate', technicalValidation: 'unknown' });
    const checked = await post('/contacts/routes/check', {
      commandId: randomUUID(), clientVersion: CLIENT_VERSION_UNDER_TEST,
      routeKind: 'email', routeId: waiting?.id ?? '', routeVersion: 1,
    });
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ result: { queued: true, routeVersion: 1 } });

    // The domain answers now; the queued check and a later sweep both reach it, and the
    // second finds the address decided and writes nothing.
    dns['quiet-law.fsstest'] = { mx: [{ exchange: 'mail.quiet-law.fsstest', priority: 10 }] };
    const { rows } = await fixture.db.query<{ now: Date }>("SELECT date_trunc('hour', now()) + interval '80 minutes' AS now");
    const pass = await runSchedulerPass(fixture.db, { sources: [routeValidationSource()], now: (rows[0]?.now ?? new Date()).toISOString() });
    expect(pass.inserted).toBe(1);
    expect(await worker()).toMatchObject({ claimed: 2, completed: 2, failed: 0 });
    expect(await address('pat@quiet-law.fsstest')).toMatchObject({
      technical_validation: 'passed',
      eligibility: 'usable',
      association_confidence: '1.000',
      version: 2,
    });
  });
});
