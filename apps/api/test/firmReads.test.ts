import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmPageResponseSchema, firmTimelineSchema } from '@fss/contracts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

/**
 * S4F: the firm page's open work and activity timeline, over the wire.
 *
 *   * both are negotiated `include`s on `POST /crm/firm-page`: without them the answer is
 *     the shape an installed desktop parses strictly;
 *   * only the firm's assignee and an admin get them: a colleague's page is the narrow one;
 *   * the timeline is codes and ids: an e-mail row is direction and a cut subject, a stop row
 *     is channel and scope, and no body, note or address appears anywhere;
 *   * the cursor is (instant, kind, id): events sharing an instant are neither skipped nor
 *     repeated across a page boundary.
 */
describe('firm page tasks and timeline', () => {
  let fixture: AuthFixture;
  let salesToken: string;
  let adminToken: string;
  let colleagueToken: string;
  let firmId: string;
  let ownerFirm: string;
  const T = '2026-09-20T15:00:00.123456Z';

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
  });
  const page = async (token: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path: '/crm/firm-page',
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };
  const timelineOf = async (token: string, before?: string) => {
    const answer = await page(token, { firmId, pageVersion: 2, include: ['timeline'], ...(before === undefined ? {} : { timelineBefore: before }) });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return firmTimelineSchema.parse(answer.body['timeline']);
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    salesToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    firmId = await seedFirm(fixture, { name: 'Timeline Test Holdings', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    // A firm assigned to the admin: the salesperson is a colleague here and gets the narrow page.
    ownerFirm = await seedFirm(fixture, { name: 'Colleague Test Holdings', regionCode: 'TX', assignedUserId: fixture.alpha.admin.userId });
    colleagueToken = salesToken;
    const workspace = fixture.alpha.workspaceId;
    const user = fixture.alpha.salesperson.userId;

    const { rows: opp } = await fixture.db.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1), now())
       RETURNING id`,
      [workspace, firmId],
    );
    const opportunityId = opp[0]?.id ?? '';

    // 120 call logs sharing ONE instant: the pagination case a timestamp-only cursor gets wrong.
    await fixture.db.query(
      `INSERT INTO call_logs (workspace_id, firm_id, outcome, step_effect, occurred_at, recorded_at, actor_user_id, note)
       SELECT $1, $2, 'no_answer', 'none', $4::timestamptz, $4::timestamptz, $3, 'A private note nobody should see in a timeline'
         FROM generate_series(1, 120)`,
      [workspace, firmId, user, T],
    );

    const { rows: mailbox } = await fixture.db.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, status)
       VALUES ($1, $2, 'seller@example.test', 'seller-account', 'connected') RETURNING id`,
      [workspace, user],
    );
    const insertMail = async (providerId: string, direction: 'incoming' | 'outgoing', subject: string): Promise<string> => {
      const { rows } = await fixture.db.query<{ id: string }>(
        `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction, internal_date, header_from, header_to, subject, matched)
         VALUES ($1, $2, $3, $3, $4, '2026-09-21T10:00:00Z', 'x@example.test', ARRAY['y@example.test'], $5, true) RETURNING id`,
        [workspace, mailbox[0]?.id ?? '', providerId, direction, subject],
      );
      return rows[0]?.id ?? '';
    };
    const sent = await insertMail('long-subject-1', 'outgoing', 'S'.repeat(200));
    const ambiguous = await insertMail('ambiguous-1', 'incoming', 'Not yet resolved to a firm');
    await fixture.db.query(
      `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule, ambiguous, selected)
       VALUES ($1, $2, $3, $4, 'participant', false, NULL)`,
      [workspace, sent, firmId, opportunityId],
    );
    // A candidate the person did not choose (`selected = false`) is not this firm's e-mail.
    await fixture.db.query(
      `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule, ambiguous, selected, resolved_at)
       VALUES ($1, $2, $3, $4, 'participant', false, false, now())`,
      [workspace, ambiguous, firmId, opportunityId],
    );

    // Open work.
    await fixture.db.query(
      `INSERT INTO call_tasks (workspace_id, firm_id, quote_key, text, due_at, created_by_user_id)
       VALUES ($1, $2, 'task:0123456789abcdef', 'Send the pricing sheet', '2026-10-05T15:00:00Z', $3),
              ($1, $2, 'task:fedcba9876543210', 'Already done', '2026-10-04T15:00:00Z', $3)`,
      [workspace, firmId, user],
    );
    await fixture.db.query(`UPDATE call_tasks SET status = 'done', completed_at = now() WHERE text = 'Already done'`);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('adds tasks and the timeline only when negotiated, so an installed desktop’s strict parse never meets them', async () => {
    const detail = firmPageResponseSchema.options[1];
    const legacy = detail.omit({ tasks: true, timeline: true });
    const without = await page(salesToken, { firmId, pageVersion: 2 });
    expect(without.status).toBe(200);
    expect('tasks' in without.body).toBe(false);
    expect('timeline' in without.body).toBe(false);
    expect(legacy.safeParse(without.body).success).toBe(true);

    const withBoth = await page(salesToken, { firmId, pageVersion: 2, include: ['tasks', 'timeline'] });
    const parsed = detail.parse(withBoth.body);
    expect(parsed.tasks?.map(task => [task.kind, task.label, task.status])).toEqual([['call_task', 'Send the pricing sheet', 'open']]);
    expect(parsed.timeline?.events.length).toBe(50);
    expect(legacy.safeParse(withBoth.body).success).toBe(false);
    // The vocabulary is closed and a cursor is a string.
    expect((await page(salesToken, { firmId, include: ['everything'] })).status).toBe(400);
  });

  it('gives the assignee and an admin the lists, and a colleague only the narrow page', async () => {
    expect((await page(adminToken, { firmId, pageVersion: 2, include: ['tasks', 'timeline'] })).body['timeline']).toBeDefined();
    const narrow = await page(colleagueToken, { firmId: ownerFirm, pageVersion: 2, include: ['tasks', 'timeline'] });
    expect(narrow.status).toBe(200);
    expect(narrow.body['visibility']).toBe('any_active_member');
    expect('tasks' in narrow.body).toBe(false);
    expect('timeline' in narrow.body).toBe(false);
    expect(JSON.stringify(narrow.body)).not.toContain('Timeline Test');
  });

  it('pages 120 events sharing one instant with no row skipped or repeated, in a stable order', async () => {
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    for (;;) {
      const result = await timelineOf(salesToken, before);
      pages += 1;
      expect(result.events.length).toBeLessThanOrEqual(50);
      seen.push(...result.events.map(event => event.key));
      if (result.nextBefore === null) break;
      before = result.nextBefore;
      expect(pages).toBeLessThan(10);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter(key => key.startsWith('call:'))).toHaveLength(120);
    // The same walk twice gives the same order.
    const again: string[] = [];
    before = undefined;
    for (;;) {
      const result = await timelineOf(salesToken, before);
      again.push(...result.events.map(event => event.key));
      if (result.nextBefore === null) break;
      before = result.nextBefore;
    }
    expect(again).toEqual(seen);
  });

  it('shows an e-mail as direction and a subject cut at 80, and never a body, a note or a candidate that was not chosen', async () => {
    const all: { kind: string; code: string | null; detail: string | null }[] = [];
    let before: string | undefined;
    for (;;) {
      const result = await timelineOf(salesToken, before);
      all.push(...result.events);
      if (result.nextBefore === null) break;
      before = result.nextBefore;
    }
    const mail = all.filter(event => event.kind.startsWith('email'));
    expect(mail.map(({ kind, code, detail }) => ({ kind, code, detail }))).toEqual([{ kind: 'email_sent', code: null, detail: 'S'.repeat(80) }]);
    expect(JSON.stringify(all)).not.toContain('private note');
    expect(JSON.stringify(all)).not.toContain('Not yet resolved');
  });

  it('tasks list open work only, soonest first', async () => {
    const answer = await page(salesToken, { firmId, pageVersion: 2, include: ['tasks'] });
    const parsed = firmPageResponseSchema.options[1].parse(answer.body);
    expect(parsed.tasks?.map(task => task.label)).toEqual(['Send the pricing sheet']);
  });

  it('an unreadable cursor is the first page again, not an error', async () => {
    const first = await timelineOf(salesToken);
    const bad = await timelineOf(salesToken, 'not-a-cursor');
    expect(bad.events.map(event => event.key)).toEqual(first.events.map(event => event.key));
  });

  it('stage changes, corrections, stops and lifts appear by code, with the stop’s channel and scope and never its key', async () => {
    const workspace = fixture.alpha.workspaceId;
    const eventId = `evt-${randomUUID()}`;
    await fixture.db.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id, channel, recorded_at)
       VALUES ($1, $2, 'firm', lower($3::text), 'v1', 'salesperson_manual', $4, 'email', '2026-09-25T12:00:00Z')`,
      [workspace, eventId, firmId, fixture.alpha.salesperson.userId],
    );
    const lifted = `evt-${randomUUID()}`;
    await fixture.db.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source, actor_user_id, channel, recorded_at, supersedes_event_id, supersession_reason)
       VALUES ($1, $2, 'firm', lower($3::text), 'v1', 'admin_supersession', $4, 'email', '2026-09-26T12:00:00Z', $5, 'correction')`,
      [workspace, lifted, firmId, fixture.alpha.admin.userId, eventId],
    );
    await fixture.db.query(
      `INSERT INTO opportunity_stage_events (workspace_id, opportunity_id, firm_id, from_stage_id, to_stage_id, actor_kind, actor_user_id, reason, occurred_at)
       SELECT $1, o.id, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1),
              (SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position OFFSET 1 LIMIT 1), 'user', $3, NULL, '2026-09-27T12:00:00Z'
         FROM opportunities o WHERE o.workspace_id = $1 AND o.firm_id = $2 LIMIT 1`,
      [workspace, firmId, fixture.alpha.salesperson.userId],
    );
    const { rows: logRow } = await fixture.db.query<{ id: string }>('SELECT id FROM call_logs WHERE firm_id = $1 LIMIT 1', [firmId]);
    await fixture.db.query(
      `INSERT INTO audit_events (workspace_id, occurred_at, actor_kind, actor_user_id, action, subject_kind, subject_id, detail)
       VALUES ($1, '2026-09-28T12:00:00Z', 'user', $2, 'call.outcome_corrected', 'call_log', $3, '{"from":"no_answer","to":"interested","revision":1}'::jsonb)`,
      [workspace, fixture.alpha.salesperson.userId, logRow[0]?.id ?? ''],
    );
    const all: { kind: string; code: string | null; detail: string | null }[] = [];
    let before: string | undefined;
    for (;;) {
      const result = await timelineOf(salesToken, before);
      all.push(...result.events);
      if (result.nextBefore === null) break;
      before = result.nextBefore;
    }
    expect(all.filter(event => event.kind === 'stop_lifted').map(event => [event.code, event.detail])).toEqual([['email', 'firm']]);
    expect(all.filter(event => event.kind === 'stage_change').map(event => event.code)).toHaveLength(1);
    expect(all.filter(event => event.kind === 'outcome_corrected').map(event => [event.code, event.detail])).toEqual([['interested', 'no_answer']]);
    // Newest first: the correction is the first row, then the stage change, the lift, the stop.
    expect(all.slice(0, 4).map(event => event.kind)).toEqual(['outcome_corrected', 'stage_change', 'stop_lifted', 'stop_recorded']);
    expect(all.filter(event => event.kind === 'stop_recorded')).toEqual([{ kind: 'stop_recorded', code: 'email', detail: 'firm' }].map(row => expect.objectContaining(row)));
    expect(JSON.stringify(all)).not.toContain(firmId.toLowerCase());
  });
});
