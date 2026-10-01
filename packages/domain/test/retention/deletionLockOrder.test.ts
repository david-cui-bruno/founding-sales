import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { consumeCallSession, createCallSession } from '../../calls/sessions.ts';
import { beginClassification, ensureClassificationCalling } from '../../classification/classify.ts';
import { RESEARCH_FIRM_MAX_RESERVATIONS } from '../../research/ceilings.ts';
import { beginFirmResearch, ensureResearchCalling, finishFirmResearch } from '../../research/enrichment.ts';
import type { PageFetchProvider } from '../../research/providers.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { updateSetting } from '../../settings/store.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Slice P1, final round, findings 4 and 5: the deletion workflow and the paid paths in one
 * lock order — firm, then subjects, then the monthly spend lock, then rows.
 *
 * Each case drives two real connections into the interleaving the verification traced:
 *
 *   * a classification paused in chunk 2 (it holds the monthly lock and then records its
 *     `disabled` attempt, whose row references the message) against a firm deletion that
 *     deletes the message and then settles an open call reservation (the monthly lock);
 *   * a page-only research chunk 3 (it holds the run and writes evidence, which references
 *     the firm) against a firm deletion that locks the firm and then deletes the run.
 *
 * With the order, the second transaction waits for the first and both finish; without it
 * PostgreSQL reports a deadlock (40P01) and aborts one.
 */
describe('the deletion workflow against the paid paths, at once (P1 final round)', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  const clients: pg.Client[] = [];

  const on = (db: SessionQueryable, actor: 'worker' | 'admin' | 'salesperson' = 'worker'): RepositoryContext =>
    repositoryContext(
      workspaceScope(
        seeded.alpha.workspaceId,
        actor === 'worker'
          ? { kind: 'system', component: 'worker' }
          : actor === 'admin'
            ? { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }
            : { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' },
      ),
      db,
    );

  async function connection(): Promise<SessionQueryable> {
    const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
    url.pathname = `/${database.name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    await client.connect();
    clients.push(client);
    return asSession(client as unknown as Parameters<typeof asSession>[0]);
  }

  /** Signals one transaction raises and the other waits for, or gives up on after `ms`. */
  function signals(...names: string[]) {
    const resolvers = new Map<string, () => void>();
    const fired = new Map<string, Promise<void>>();
    for (const name of names) fired.set(name, new Promise<void>(resolve => resolvers.set(name, resolve)));
    return {
      fire: (name: string): void => resolvers.get(name)?.(),
      within: async (name: string, ms: number): Promise<void> =>
        await Promise.race([fired.get(name), new Promise<void>(resolve => setTimeout(resolve, ms))]),
    };
  }

  /** A session that runs `after` once the first statement matching `when` has returned. */
  function watched(raw: SessionQueryable, when: (text: string, values?: readonly unknown[]) => boolean, after: () => Promise<void>): SessionQueryable {
    let done = false;
    return {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        const result = await raw.query<Row>(text, values);
        if (!done && when(text, values)) {
          done = true;
          await after();
        }
        return result;
      },
    };
  }

  const codeOf = (outcome: PromiseSettledResult<unknown>): string | null =>
    outcome.status === 'rejected' ? String((outcome.reason as { code?: string }).code ?? (outcome.reason as Error).message) : null;

  async function preview(firmId: string): Promise<{ requestId: string; previewHash: string }> {
    const previewed = await withTransaction(database.session, async () => await previewDeletion(on(database.session, 'admin'), { targetKind: 'firm', firmId }));
    if (!previewed.ok) throw new Error(previewed.reason);
    return { requestId: previewed.value.requestId, previewHash: previewed.value.previewHash };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    const saved = await withTransaction(database.session, async () =>
      await updateSetting(on(database.session, 'admin'), {
        settingKey: 'telephony_budget',
        value: { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 },
      }),
    );
    if (!saved.ok) throw new Error(saved.reason);
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    await database.drop();
  });

  it('a page-only research chunk 3 and a firm deletion: both finish (#5)', async () => {
    const firmId = (
      await database.session.query<{ id: string }>(
        `INSERT INTO firms (workspace_id, name, assigned_user_id, website, locality, region_code, postal_code,
                            time_zone, time_zone_confidence, time_zone_source, time_zone_rule_version)
         VALUES ($1, 'Page Only Holdings', $2, 'https://pageonly.example.test', 'Providence', 'RI', '02903',
                 'America/New_York', 'medium', 'state_default', 'firm-zone.1') RETURNING id`,
        [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
      )
    ).rows[0]?.id ?? '';
    const at = new Date().toISOString();
    const started = await withTransaction(database.session, async () =>
      await beginFirmResearch(on(database.session), { firmId, revision: 1, trigger: 'sweep', at }),
    );
    if (!started.ok || started.value.kind !== 'reserved') throw new Error('chunk 1 did not reserve');
    const runId = started.value.runId;
    const permission = await withTransaction(database.session, async () =>
      await ensureResearchCalling(on(database.session), { runId, at, maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS, hasExtraction: false }),
    );
    if (permission.kind !== 'unconfigured') throw new Error(`chunk 2 answered ${permission.kind}`);
    const request = await preview(firmId);

    const page = `<p>${'We manage residential property for owners. '.repeat(20)}</p>`;
    const fetch: PageFetchProvider = {
      providerKey: 'company_page',
      fetchPages: async input => ({
        ok: true as const,
        costCents: 0,
        value: {
          pages: input.urls.slice(0, 1).map(url => ({
            url,
            contentHash: createHash('sha256').update(page, 'utf8').digest('hex'),
            contentType: 'text/html; charset=utf-8',
            body: new TextEncoder().encode(page),
            retrievedAt: at,
            firstParty: true,
          })),
          skipped: {},
        },
      }),
    };
    const flags = signals('researchHoldsRun', 'deletionHoldsFirm');
    const research = watched(
      await connection(),
      text => text.includes('FROM research_runs') && text.includes('FOR UPDATE'),
      async () => {
        flags.fire('researchHoldsRun');
        await flags.within('deletionHoldsFirm', 1500);
      },
    );
    const deletion = watched(
      await connection(),
      text => text.startsWith('SELECT id FROM firms') && text.includes('FOR UPDATE'),
      async () => {
        flags.fire('deletionHoldsFirm');
      },
    );
    const chunkThree = withTransaction(research, async () =>
      await finishFirmResearch(on(research), { runId, firmId, revision: 1, at, attempt: permission.attempt, mayCall: false, pageFetch: fetch }),
    );
    await flags.within('researchHoldsRun', 3000);
    const deleting = withTransaction(deletion, async () =>
      await commitDeletion(on(deletion, 'admin'), { ...request, commandId: 'lock-order-research', journal: recordingSuppressionJournal() }),
    );
    const settled = await Promise.allSettled([chunkThree, deleting]);
    expect(settled.map(codeOf)).toEqual([null, null]);
  }, 30_000);

  it('a classification paused in chunk 2 and a firm deletion with an open call: both finish (#4)', async () => {
    const firmId = crm.alpha.firmId;
    // An open call reservation of the firm's, which the deletion settles (a ledger write).
    const created = await withTransaction(database.session, async () =>
      await createCallSession(on(database.session, 'salesperson'), {
        firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: 'lock-order-call',
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        sessionId: created.value.sessionId,
        callSid: `CA${randomBytes(16).toString('hex')}`,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    if (!consumed.ok) throw new Error(consumed.reason);

    // A matched reply of the firm's, the deterministic layer unsure, with chunk 1 reserved.
    const mailbox = (
      await database.session.query<{ id: string }>(
        `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, sync_state,
                                history_id, history_id_updated_at, baseline_from_at, baseline_completed_at, coverage_watermark_at)
         VALUES ($1, $2, 'lockorder@example.test', 'gmail-lock-order', 'ready', '1', now(), now() - interval '30 days', now(), now())
         RETURNING id`,
        [seeded.alpha.workspaceId, seeded.alpha.salesperson.userId],
      )
    ).rows[0]?.id ?? '';
    const messageId = (
      await database.session.query<{ id: string }>(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction, internal_date,
                                    header_from, header_to, subject, matched, metadata_only)
         VALUES ($1, $2, 'lock-order-1', 'lock-order-thread', 'incoming', now(), 'owner@firm.example.test',
                 ARRAY['lockorder@example.test']::text[], 'Re: hello', true, false)
         RETURNING id`,
        [seeded.alpha.workspaceId, mailbox],
      )
    ).rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text, truncated) VALUES ($1, $2, 'Tuesday works.', false)",
      [seeded.alpha.workspaceId, messageId],
    );
    await database.session.query(
      "INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule) VALUES ($1, $2, $3, $4, 'participant')",
      [seeded.alpha.workspaceId, messageId, firmId, crm.alpha.opportunityId],
    );
    await database.session.query(
      `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class, requires_confirmation, rules_version)
       VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1')`,
      [seeded.alpha.workspaceId, messageId],
    );
    await database.session.query(
      `INSERT INTO classifier_settings (workspace_id, enabled, model_name, effort, max_output_tokens, daily_call_cap)
       VALUES ($1, true, 'claude-opus-5', 'low', 512, 500)
       ON CONFLICT (workspace_id) DO UPDATE SET enabled = true`,
      [seeded.alpha.workspaceId],
    );
    const deps = { classifierFor: () => ({ classify: async () => await Promise.reject(new Error('never sent')) }), processEnabled: true };
    const begun = await withTransaction(database.session, async () =>
      await beginClassification(on(database.session), deps, { messageId, retry: false }),
    );
    if (begun.kind !== 'reserved') throw new Error('chunk 1 did not reserve');
    // Paused before chunk 2, so chunk 2 records `disabled` after its monthly lock.
    await database.session.query('UPDATE classifier_settings SET enabled = false WHERE workspace_id = $1', [seeded.alpha.workspaceId]);
    const request = await preview(firmId);

    const flags = signals('classifierHoldsMonth', 'deletionDeletedMessage');
    const classifier = watched(
      await connection(),
      (text, values) => text.includes('advisory_xact_lock') && typeof values?.[0] === 'string' && values[0].endsWith(':monthly_cash_ceiling'),
      async () => {
        flags.fire('classifierHoldsMonth');
        await flags.within('deletionDeletedMessage', 1500);
      },
    );
    const deletion = watched(
      await connection(),
      text => text.includes('DELETE FROM mail_messages'),
      async () => {
        flags.fire('deletionDeletedMessage');
      },
    );
    const chunkTwo = withTransaction(classifier, async () =>
      await ensureClassificationCalling(on(classifier), deps, { messageId, attempt: begun.attempt }),
    );
    await flags.within('classifierHoldsMonth', 3000);
    const deleting = withTransaction(deletion, async () =>
      await commitDeletion(on(deletion, 'admin'), { ...request, commandId: 'lock-order-classifier', journal: recordingSuppressionJournal() }),
    );
    const settled = await Promise.allSettled([chunkTwo, deleting]);
    expect(settled.map(codeOf)).toEqual([null, null]);
    expect(settled[0]).toMatchObject({ status: 'fulfilled', value: { kind: 'done', report: { outcome: 'disabled' } } });
  }, 30_000);
});
