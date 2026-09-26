import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '../../db/testing/index.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  normalizeSendingDomain,
  readPrimarySendingDomain,
  recordAuthenticationChecklist,
  registerMailboxSendingDomain,
  registerSendingDomain,
  setAutomatedSendingEnabled,
} from '../../outbound/index.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * `registerSendingDomain`, the only creator of a `sending_domains` row (lane g57).
 *
 * Until it existed, `recordAuthenticationChecklist` answered `domain_unknown` in every
 * real workspace, because the row it updates was written by nothing but the tests and
 * the rehearsal's seed. So the first thing proved here is the positive one — through
 * the **application role**, not the superuser, because the grant is the thing a
 * superuser test cannot see — and then each of the four things the function must never
 * do: reset a checklist, move a primary, register personal Gmail, or accept a value
 * the table's CHECK would refuse.
 *
 * ## The vacuous-pass trap, named
 *
 * A registration that inserted nothing and returned `existing` would satisfy every
 * idempotence assertion in this file. So the first case asserts `created`, reads the
 * row back through `readPrimarySendingDomain`, and records a checklist on it — the
 * call that failed in production — so a registration that inserts nothing turns this
 * file red.
 */

let database: TestDatabase;
let seeded: TwoWorkspaces;
let runtime: SessionQueryable;

function adminOf(workspace: TwoWorkspaces['alpha'], session: SessionQueryable): RepositoryContext {
  return repositoryContext(
    workspaceScope(workspace.workspaceId, { kind: 'user', userId: workspace.admin.userId, role: 'admin' }),
    session,
  );
}

async function countOf(sql: string, values: readonly unknown[]): Promise<number> {
  const { rows } = await database.session.query<{ count: string }>(sql, values);
  return Number(rows[0]?.count ?? '0');
}

const domainsIn = async (workspaceId: string): Promise<number> =>
  await countOf('SELECT count(*)::text AS count FROM sending_domains WHERE workspace_id = $1', [workspaceId]);
const auditsIn = async (workspaceId: string): Promise<number> =>
  await countOf(
    "SELECT count(*)::text AS count FROM audit_events WHERE workspace_id = $1 AND action = 'sending_domain.registered'",
    [workspaceId],
  );

beforeAll(async () => {
  database = await createTestDatabase();
  seeded = await seedTwoWorkspaces(database.session);
  runtime = await database.appRuntimeSession();
}, 180_000);

afterAll(async () => {
  await database?.drop();
});

describe('normalizeSendingDomain', () => {
  it('lower-cases and trims a host name, and accepts subdomains', () => {
    expect(normalizeSendingDomain('  UseCallie.COM ')).toEqual({ ok: true, domain: 'usecallie.com' });
    expect(normalizeSendingDomain('mail.use-callie.example.test')).toEqual({
      ok: true,
      domain: 'mail.use-callie.example.test',
    });
  });

  it('refuses an address, a scheme, a path, a bare label, an IP and what DNS would refuse', () => {
    for (const value of [
      '',
      '   ',
      'callie@usecallie.com',
      '@usecallie.com',
      'https://usecallie.com',
      'usecallie.com/',
      'use callie.com',
      'usecallie',
      'usecallie.com.',
      '.usecallie.com',
      '-usecallie.com',
      'usecallie-.com',
      'use_callie.com',
      '10.0.0.1',
      `${'a'.repeat(64)}.com`,
      `${'a.'.repeat(127)}com`,
    ]) {
      expect(normalizeSendingDomain(value), JSON.stringify(value)).toEqual({ ok: false, reason: 'domain_invalid' });
    }
  });

  it('refuses personal Gmail by name, because 12.6 treats it as a recipient class', () => {
    expect(normalizeSendingDomain('gmail.com')).toEqual({ ok: false, reason: 'personal_gmail_domain' });
    expect(normalizeSendingDomain('GoogleMail.com')).toEqual({ ok: false, reason: 'personal_gmail_domain' });
  });
});

describe('registerSendingDomain', () => {
  it('creates the primary row with the checklist unticked, through the application role', async () => {
    const context = adminOf(seeded.alpha, runtime);
    expect(await readPrimarySendingDomain(context)).toBeNull();

    const registered = await registerSendingDomain(context, { domain: 'Sending.Example.Test', registeredBy: 'admin' });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.outcome).toBe('created');
    expect(registered.domain).toMatchObject({
      domain: 'sending.example.test',
      isPrimary: true,
      spfPass: false,
      dkimPass: false,
      dmarcPass: false,
      postmasterReviewedAt: null,
      automatedSendingEnabled: false,
    });

    // What Administration reads, and the command that answered `domain_unknown` in
    // production until this row could exist.
    expect((await readPrimarySendingDomain(context))?.id).toBe(registered.domain.id);
    const recorded = await recordAuthenticationChecklist(context, {
      domain: 'sending.example.test',
      adminUserId: seeded.alpha.admin.userId,
      spfPass: true,
      dkimPass: true,
      dmarcPass: true,
      postmasterReviewed: true,
    });
    expect(recorded.ok).toBe(true);
    expect((await setAutomatedSendingEnabled(context, { domain: 'sending.example.test', enabled: true })).ok).toBe(
      true,
    );

    // Audited as the actor who registered it, with who asked in the detail.
    const audit = await database.session.query<{ actor_kind: string; actor_user_id: string; detail: unknown }>(
      "SELECT actor_kind, actor_user_id, detail FROM audit_events WHERE workspace_id = $1 AND action = 'sending_domain.registered'",
      [seeded.alpha.workspaceId],
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'admin',
        actor_user_id: seeded.alpha.admin.userId,
        detail: { domain: 'sending.example.test', isPrimary: true, registeredBy: 'admin' },
      },
    ]);
  });

  it('returns an existing row unchanged: the checklist and the enable survive a re-registration', async () => {
    const context = adminOf(seeded.alpha, runtime);
    const again = await registerSendingDomain(context, { domain: 'sending.example.test', registeredBy: 'operator' });
    expect(again).toMatchObject({
      ok: true,
      outcome: 'existing',
      domain: { isPrimary: true, spfPass: true, dkimPass: true, dmarcPass: true, automatedSendingEnabled: true },
    });
    // The mailbox path, for the same domain, is the same read.
    const connected = await registerMailboxSendingDomain(context, { emailAddress: 'Sales@Sending.Example.Test' });
    expect(connected).toMatchObject({ ok: true, outcome: 'existing', domain: { automatedSendingEnabled: true } });
    expect(await domainsIn(seeded.alpha.workspaceId)).toBe(1);
    expect(await auditsIn(seeded.alpha.workspaceId)).toBe(1);
  });

  it('registers a second domain beside the primary and never moves the primary', async () => {
    const context = adminOf(seeded.alpha, runtime);
    const second = await registerSendingDomain(context, { domain: 'second.example.test', registeredBy: 'admin' });
    expect(second).toMatchObject({ ok: true, outcome: 'created', domain: { isPrimary: false } });
    expect((await readPrimarySendingDomain(context))?.domain).toBe('sending.example.test');
  });

  it('is per workspace: the same name is a new primary in the other one', async () => {
    const beta = adminOf(seeded.beta, runtime);
    const registered = await registerSendingDomain(beta, { domain: 'sending.example.test', registeredBy: 'admin' });
    expect(registered).toMatchObject({
      ok: true,
      outcome: 'created',
      domain: { isPrimary: true, spfPass: false, automatedSendingEnabled: false },
    });
    // Alpha's checklist is not beta's.
    expect((await readPrimarySendingDomain(adminOf(seeded.alpha, runtime)))?.automatedSendingEnabled).toBe(true);
  });

  it('refuses an invalid domain and personal Gmail, and writes nothing', async () => {
    const context = adminOf(seeded.alpha, runtime);
    const rows = await domainsIn(seeded.alpha.workspaceId);
    const audits = await auditsIn(seeded.alpha.workspaceId);
    expect(await registerSendingDomain(context, { domain: 'callie@example.test', registeredBy: 'admin' })).toEqual({
      ok: false,
      reason: 'domain_invalid',
    });
    expect(await registerSendingDomain(context, { domain: 'gmail.com', registeredBy: 'admin' })).toEqual({
      ok: false,
      reason: 'personal_gmail_domain',
    });
    expect(await registerMailboxSendingDomain(context, { emailAddress: 'someone@googlemail.com' })).toEqual({
      ok: false,
      reason: 'personal_gmail_domain',
    });
    expect(await registerMailboxSendingDomain(context, { emailAddress: 'no-at-sign' })).toEqual({
      ok: false,
      reason: 'domain_invalid',
    });
    expect(await domainsIn(seeded.alpha.workspaceId)).toBe(rows);
    expect(await auditsIn(seeded.alpha.workspaceId)).toBe(audits);
  });

  it('settles two concurrent first registrations on exactly one primary', async () => {
    // A workspace with no domain yet, and two sessions racing to register two
    // different names. The loser's insert waits on `sending_domains_one_primary`, does
    // nothing when the winner commits, and the next pass registers it beside the
    // winner — rather than failing, or making a second primary.
    const created = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('race', 'Race') RETURNING id",
    );
    const workspaceId = created.rows[0]?.id ?? '';
    const system = { kind: 'system', component: 'migration' } as const;
    const first = await database.appRuntimeSession();
    const second = await database.appRuntimeSession();
    const firstContext = repositoryContext(workspaceScope(workspaceId, system), first);
    const secondContext = repositoryContext(workspaceScope(workspaceId, system), second);

    await first.query('BEGIN');
    const winner = await registerSendingDomain(firstContext, { domain: 'first.example.test', registeredBy: 'operator' });
    const loser = withTransaction(second, async () =>
      registerSendingDomain(secondContext, { domain: 'second.example.test', registeredBy: 'operator' }),
    );
    // Give the second session time to reach the insert and wait on the first.
    await new Promise(resolve => setTimeout(resolve, 250));
    await first.query('COMMIT');

    expect(winner).toMatchObject({ ok: true, outcome: 'created', domain: { isPrimary: true } });
    expect(await loser).toMatchObject({ ok: true, outcome: 'created', domain: { isPrimary: false } });
    expect(
      await countOf('SELECT count(*)::text AS count FROM sending_domains WHERE workspace_id = $1 AND is_primary', [
        workspaceId,
      ]),
    ).toBe(1);
    expect(await domainsIn(workspaceId)).toBe(2);
  });
});
