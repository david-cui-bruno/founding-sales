import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_ELIGIBILITY_POLICY_VERSION } from '../../../../packages/domain/crm/routePolicy.ts';
import { HandlerRegistry } from '@fss/domain/jobs';
import type { MailDomainResolver, MailExchangeRecord } from '@fss/domain/crm';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from '../support/authFixture.ts';
import { issueSessionFor } from '../support/sessionFixture.ts';
import { createCrmBridge } from '../../../desktop/src/main/crmBridge.ts';
import { EMAIL_VALIDATION_TEXT, emailValidationStateOf } from '../../../desktop/src/renderer/firmWorkspaceView.ts';
import { runOnce } from '../../../worker/src/runner/jobRunner.ts';
import { runSchedulerPass } from '../../../worker/src/scheduler/schedulerPass.ts';
import { routeValidateJobHandler, routeValidationSource } from '../../../worker/src/handlers/routeValidate.ts';
import { desktopClient } from '../support/wireThrough.ts';

/**
 * An address imported or added from the Mac ends `usable` once its domain checks out
 * (release-records.md 8.0aw; lane g90, specification 7.4).
 *
 * Until g90 an address that came in through Import or Add firm was `unknown` and
 * `candidate` for ever: nothing validated it, and once sending opens on about 1 October
 * every email step to such a contact holds as `route_candidate` at the frozen-route
 * check (PR 216). This check drives the shipped pieces end to end, the way the local
 * drill does — the CRM window's bridge through the real API routes over a real
 * PostgreSQL, then the worker's own runner and scheduler pass with the `route.validate`
 * handler — and asks the database, and the Firm page the Mac draws, what landed.
 *
 * The one substitution is DNS: the handler is given a table instead of the process's
 * resolver, because a release check asks nothing of the network.
 *
 * ## The vacuous-pass traps, named
 *
 * **An address usable from the start.** Both addresses are required to be unchecked
 * candidates after the import and the add, before any job runs; a fixture that brought
 * its own verdict would pass with the validator deleted.
 *
 * **A validator that marks everything usable.** One domain in the table does not exist,
 * and its address is required to end `invalid`; one never answers, and its address is
 * required to stay `candidate` until the sweep asks again and gets an answer.
 *
 * **A page that says the right words about nothing.** The state the Firm page shows is
 * read from the page the bridge fetched after the worker ran, not from a fixture.
 *
 * Domains are under `.fsstest`, a top-level name that does not exist.
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

describe('8.0aw: an imported address is checked and ends usable (lane g90)', () => {
  let fixture: AuthFixture;
  let adminToken = '';
  const dns: Record<string, DomainAnswers> = {
    'harbor-law.fsstest': { mx: [{ exchange: 'mail.harbor-law.fsstest', priority: 10 }] },
    'nowhere-law.fsstest': { mx: { code: 'ENOTFOUND' } },
    'quiet-law.fsstest': { mx: { code: 'ETIMEOUT' } },
  };

  const session = { state: async () => await Promise.resolve({ online: true, mayMutate: true, device: { role: 'admin' as const } }) };
  const crm = () => createCrmBridge({ api: desktopClient(fixture, adminToken), clientVersion: CURRENT_CLIENT_VERSION, session });
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
    const admin = crm();
    await admin.openImport();
    const csv = [
      'firm_name,website,contact_name,contact_email,region_code',
      'Harbor Test Law,harbor-law.fsstest,Kim Placeholder,kim@harbor-law.fsstest,RI',
      'Nowhere Test Law,nowhere-law.fsstest,Lee Placeholder,lee@nowhere-law.fsstest,RI',
    ].join('\n');
    const previewed = await admin.previewImport({ csv, fileName: 'prospects.csv' });
    expect(previewed.import?.preview?.counts).toMatchObject({ create: 2, invalid: 0 });
    const committed = await admin.commitImport();
    expect(committed.import?.results?.results.map(result => result.status)).toEqual(['accepted', 'accepted']);

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

    // What the Mac draws for it, from the page it fetches now.
    const opened = await admin.openFirm({ firmId: before?.firm_id ?? '' });
    const page = opened.firm;
    const routes = page?.read.visibility === 'assigned_or_admin' ? page.read.firm.emailRoutes : [];
    expect(routes.map(entry => [entry.eligibility, entry.technicalValidation, entry.version])).toEqual([['usable', 'passed', 2]]);
    const state = routes[0] === undefined ? null : emailValidationStateOf(routes[0]);
    expect(state === null ? null : EMAIL_VALIDATION_TEXT[state]).toBe('Deliverable domain — usable');
  });

  it('keeps an unanswered address a candidate until the sweep asks again, and Check again queues one more', async () => {
    const admin = crm();
    await admin.openAddFirm();
    const added = await admin.addFirm({
      name: 'Quiet Test Law',
      website: 'quiet-law.fsstest',
      timeZone: 'America/New_York',
      contactName: 'Pat Placeholder',
      contactTitle: '',
      contactEmail: 'pat@quiet-law.fsstest',
      contactPhone: '',
    });
    expect(added.notice).toBe('firm_added');
    expect(await worker()).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const waiting = await address('pat@quiet-law.fsstest');
    expect(waiting).toMatchObject({ source: 'salesperson', technical_validation: 'unknown', eligibility: 'candidate', version: 1 });

    const page = (await admin.openFirm({ firmId: waiting?.firm_id ?? '' })).firm;
    const shown = page?.read.visibility === 'assigned_or_admin' ? page.read.firm.emailRoutes[0] : undefined;
    expect(shown === undefined ? null : emailValidationStateOf(shown)).toBe('checking');

    const checked = await admin.checkRoute({ routeId: waiting?.id ?? '', routeVersion: 1 });
    expect(checked.notice).toBe('route_check_queued');

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
