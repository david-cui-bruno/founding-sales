import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  OUTDATED_CLIENT_VERSION,
  type AuthFixture,
} from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * The reply routes, through the real dispatcher with real sessions (8.3, 10.1).
 *
 * What is proved here is the wiring; the rules have their own tests against a real
 * PostgreSQL in `@fss/domain/classification`. Four things are wiring and each has
 * been wrong in a surface like this before: the paths need a session, a confirmation
 * is a command with a receipt so a double click confirms once, the configuration
 * write is an admin's and the read is not, and a card a caller may not see is
 * `not_found` rather than an empty one.
 */
describe('reply card routes', () => {
  let fixture: AuthFixture;
  let assigneeToken: string;
  let adminToken: string;
  let messageId: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    expectedSystemGeneration: null,
    auth: fixture.deps,
    suppressionJournal: localNoopSuppressionJournal(),
  });

  const post = async (
    path: string,
    token: string | null,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: result.body as Record<string, unknown> };
  };

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;

    const db = fixture.db;
    const workspaceId = fixture.alpha.workspaceId;
    const ownerUserId = fixture.alpha.salesperson.userId;

    const mailbox = await db.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, sync_state,
                              history_id, history_id_updated_at, baseline_from_at, baseline_completed_at,
                              coverage_watermark_at)
       VALUES ($1, $2, $3, 'gmail-account-1', 'ready', '1000', now(), now() - interval '30 days', now(), now())
       RETURNING id`,
      [workspaceId, ownerUserId, `sales.alpha@${fixture.hostedDomain}`],
    );
    const firm = await db.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Northgate Test Holdings', $2)
       RETURNING id`,
      [workspaceId, ownerUserId],
    );
    const stage = await db.query<{ id: string }>(
      'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
      [workspaceId],
    );
    const opportunity = await db.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [workspaceId, firm.rows[0]?.id, stage.rows[0]?.id],
    );
    const message = await db.query<{ id: string }>(
      `INSERT INTO mail_messages (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
                                  internal_date, header_from, header_to, subject, matched, metadata_only)
       VALUES ($1, $2, 'm-1', 'thread-m-1', 'incoming', now(), 'reception@northwind.example.test',
               ARRAY[$3]::text[], 'Re: hello', true, false)
       RETURNING id`,
      [workspaceId, mailbox.rows[0]?.id, `sales.alpha@${fixture.hostedDomain}`],
    );
    messageId = message.rows[0]?.id ?? '';
    await db.query(
      `INSERT INTO mail_message_bodies (workspace_id, mail_message_id, body_text, truncated)
       VALUES ($1, $2, 'Tuesday works. Send an invite.', false)`,
      [workspaceId, messageId],
    );
    await db.query(
      `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, match_rule)
       VALUES ($1, $2, $3, $4, 'participant')`,
      [workspaceId, messageId, firm.rows[0]?.id, opportunity.rows[0]?.id],
    );
    await db.query(
      `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                 requires_confirmation, rules_version, suggested_disposition)
       VALUES ($1, $2, 'deterministic', 'uncertain', true, 'reply.1', NULL)`,
      [workspaceId, messageId],
    );
    await db.query(
      `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                                 requires_confirmation, rules_version, suggested_disposition,
                                                 model_name, prompt_version, confidence, supporting_excerpt, effort)
       VALUES ($1, $2, 'model', 'uncertain', true, 'reply.1', 'interested', 'claude-opus-5', 'g7b.replies.1',
               0.880, 'Tuesday works.', 'low')`,
      [workspaceId, messageId],
    );
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses every reply path without a session, and the commands to an outdated client', async () => {
    for (const path of ['/replies', '/replies/card', '/replies/confirm', '/replies/settings']) {
      expect((await post(path, null, {})).status, path).toBe(401);
    }
    const outdated = await post(
      '/replies/confirm',
      assigneeToken,
      command({ messageId, disposition: 'interested', clientVersion: OUTDATED_CLIENT_VERSION }),
    );
    expect(outdated.status).toBe(426);
  });

  it('refuses a method other than POST, because every read here takes a body', async () => {
    const result = await dispatch(
      { method: 'GET', path: '/replies/card', query: new URLSearchParams(), headers: {}, body: undefined },
      options(),
    );
    expect(result.status).toBe(405);
  });

  it('returns the card with both layers on it, and 404 for a message in another workspace', async () => {
    const card = await post('/replies/card', assigneeToken, { messageId });
    expect(card.status).toBe(200);
    expect(card.body['deterministicClass']).toBe('uncertain');
    expect(card.body['proposedDisposition']).toBe('interested');
    expect(card.body['proposedBy']).toBe('model');
    expect(card.body['supportingExcerpt']).toBe('Tuesday works.');
    expect(card.body['nextAction']).toBe('confirm_disposition');
    expect(card.body['modelName']).toBe('claude-opus-5');

    const betaToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
    expect((await post('/replies/card', betaToken, { messageId })).status).toBe(404);
  });

  it('lists the day’s reply lane, and refuses a malformed body', async () => {
    const list = await post('/replies', assigneeToken, {});
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body['cards'])).toBe(true);
    expect(typeof list.body['businessDate']).toBe('string');

    const bad = await post('/replies', assigneeToken, { limit: 'lots' });
    expect(bad.status).toBe(400);
  });

  it('reads the classifier configuration for anybody and writes it only for an admin', async () => {
    const read = await post('/replies/settings', assigneeToken, {});
    expect(read.status).toBe(200);
    expect(read.body['modelName']).toBe('claude-opus-5');
    expect(read.body['effort']).toBe('low');

    const refused = await post('/replies/settings/update', assigneeToken, command({ enabled: false }));
    expect(refused.status).toBe(409);
    expect(refused.body['reason']).toBe('admin_only');

    const accepted = await post('/replies/settings/update', adminToken, command({ effort: 'medium' }));
    expect(accepted.status).toBe(200);
    expect((accepted.body['result'] as Record<string, unknown>)['effort']).toBe('medium');

    const unknownModel = await post(
      '/replies/settings/update',
      adminToken,
      command({ modelName: 'claude-opus-5-20260401' }),
    );
    expect(unknownModel.status).toBe(400);
  });

  it('confirms once: a replayed command id returns the original result rather than confirming twice', async () => {
    const body = command({ messageId, disposition: 'interested' });
    const first = await post('/replies/confirm', assigneeToken, body);
    expect(first.status).toBe(200);
    expect(first.body['replayed']).toBe(false);
    const result = first.body['result'] as Record<string, unknown>;
    expect((result['confirmation'] as Record<string, unknown>)['disposition']).toBe('interested');
    expect(result['suggestsLost']).toBe(false);

    const replayed = await post('/replies/confirm', assigneeToken, body);
    expect(replayed.status).toBe(200);
    expect(replayed.body['replayed']).toBe(true);

    // A *different* command id is a second confirmation, and the domain refuses it.
    const second = await post('/replies/confirm', assigneeToken, command({ messageId, disposition: 'other' }));
    expect(second.status).toBe(409);
    expect(second.body['reason']).toBe('already_confirmed');

    const after = await post('/replies/card', assigneeToken, { messageId });
    expect(after.body['nextAction']).toBe('nothing_to_do');
    // The person accepted the model's preselection, so this is a confirmation and
    // not a correction — which is what 12.4 asks the audit to be able to tell apart.
    expect((after.body['confirmation'] as Record<string, unknown>)['corrected']).toBe(false);
  });
});
