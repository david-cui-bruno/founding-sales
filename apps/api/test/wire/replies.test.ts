import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifierSettingsResponseSchema,
  confirmReplyResultSchema,
  mayMutate,
  replyCardDtoSchema,
  replyListResponseSchema,
  wireDrift,
} from '@fss/contracts';
import { CONTAINER_CLIENT_VERSIONS } from '../../src/bootstrap/main.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from '../support/authFixture.ts';
import { issueSessionFor } from '../support/sessionFixture.ts';
import { createReplyBridge } from '../../../desktop/src/main/replyBridge.ts';
import { buildReplyView } from '../../../desktop/src/renderer/replyView.ts';
import { classifierSettingsAnswer, confirmReplyResultAnswer } from '../../../desktop/test/support/replyAnswers.ts';
import { DESKTOP_VERSION_UNDER_TEST, desktopClient, routeAnswer, shapeOf } from '../support/wireThrough.ts';

/**
 * The reply window reads the classifier at every effort the server accepts (release.md
 * 8.0aj; audit item D03).
 *
 * `/replies/settings` answers `ClassifierSettings`, whose effort is one of `low`,
 * `medium`, `high`, `xhigh` and `max` (`CLASSIFIER_EFFORTS`,
 * `packages/domain/classification/types.ts`; `classifier_settings_effort_known`,
 * migration 0011). Desktop 1.0.4's schema stopped at `high`. A workspace an admin set to
 * `xhigh` or `max` read back as `unreadable_answer`, the bridge kept `classifier: null`,
 * and the window dropped the line that says which model wrote the suggestion — nothing
 * logged, because the API had answered 200.
 *
 * ## The vacuous-pass traps, named
 *
 * **An effort the old list also knew.** The default is `low`, which every copy
 * accepted, so the workspace here is set to `max` through the real command before the
 * window reads it.
 *
 * **A fixture that agrees with the parser.** The unit suite answered the settings read
 * with the three keys the window shows. `apps/desktop/test/support/replyAnswers.ts` is
 * held to the route's answer key for key and type for type here.
 *
 * **A card the window never parses.** The card is read through the bridge's own
 * `open`, and carries a hold whose vocabulary the contract checks, so a card that
 * failed to parse would leave `open` null and fail here.
 */

describe('8.0aj: the reply window reads the classifier at max', () => {
  let fixture: AuthFixture;
  let assigneeToken = '';
  let adminToken = '';
  let messageId = '';

  const command = (extra: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  const bridge = () =>
    createReplyBridge({
      api: desktopClient(fixture, assigneeToken),
      session: {
        state: async () =>
          await Promise.resolve({ online: true, mayMutate: true, today: { businessTimeZone: 'America/New_York' } }),
      },
    });

  beforeAll(async () => {
    fixture = await createAuthFixture();
    assigneeToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin, { deviceLabel: 'Admin Mac' })).accessToken;

    const db = fixture.db;
    const workspaceId = fixture.alpha.workspaceId;
    const ownerUserId = fixture.alpha.salesperson.userId;
    const mailbox = await db.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, sync_state,
                              history_id, history_id_updated_at, baseline_from_at, baseline_completed_at,
                              coverage_watermark_at)
       VALUES ($1, $2, $3, 'gmail-account-g78', 'ready', '1000', now(), now() - interval '30 days', now(), now())
       RETURNING id`,
      [workspaceId, ownerUserId, `sales.g78@${fixture.hostedDomain}`],
    );
    const firm = await db.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, 'Northgate Test Holdings', $2) RETURNING id`,
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
       VALUES ($1, $2, 'g78-m-1', 'g78-thread-1', 'incoming', now(), 'reception@northgate.example.test',
               ARRAY[$3]::text[], 'Re: hello', true, false)
       RETURNING id`,
      [workspaceId, mailbox.rows[0]?.id, `sales.g78@${fixture.hostedDomain}`],
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
               0.880, 'Tuesday works.', 'max')`,
      [workspaceId, messageId],
    );
    // The hold the message opened, in the vocabularies the contract checks.
    await db.query(
      `INSERT INTO active_holds (workspace_id, scope_kind, scope_key, reason_code, blocked_action_kinds,
                                 source_event_kind, source_event_id, recovery_action)
       VALUES ($1, 'opportunity', $2, 'uncertain_reply', ARRAY['email_send'], 'mail_message', $3, 'confirm_reply')`,
      [workspaceId, opportunity.rows[0]?.id, messageId],
    );

    // The effort the old list did not know, set through the real command.
    const set = await routeAnswer(fixture, 'POST', '/replies/settings/update', adminToken, command({ effort: 'max' }));
    expect(set.status).toBe(200);
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('renders the classifier line at max, and the card with its hold, from the real routes', async () => {
    const replies = bridge();
    const lane = await replies.refresh();
    expect(lane.notice).toBeNull();
    expect(lane.classifier).toEqual({ enabled: true, modelName: 'claude-opus-5', effort: 'max' });
    expect(buildReplyView(lane, null).classifierLine).toBe('Suggestions come from claude-opus-5 at max effort.');

    const opened = await replies.open({ messageId });
    expect(opened.notice).toBeNull();
    expect(opened.open?.messageId).toBe(messageId);
    const view = buildReplyView(opened, null);
    expect(view.card?.impactLines).toContain('On hold: uncertain_reply — email_send paused.');
    expect(view.card?.nextAction).toBe('confirm_disposition');
  });

  it('holds the desktop’s unit fixtures to the routes: the same keys, the same types, all the way down', async () => {
    const settings = await routeAnswer(fixture, 'POST', '/replies/settings', assigneeToken, {});
    expect(wireDrift(classifierSettingsResponseSchema, settings.body)).toEqual([]);
    expect(shapeOf(settings.body)).toEqual(
      shapeOf(classifierSettingsAnswer({ effort: 'max', updatedByUserId: fixture.alpha.admin.userId, updatedAt: '2026-09-25T12:00:00.000Z' })),
    );
    expect((settings.body as { effort: unknown }).effort).toBe('max');

    const card = await routeAnswer(fixture, 'POST', '/replies/card', assigneeToken, { messageId });
    expect(wireDrift(replyCardDtoSchema, card.body)).toEqual([]);
    const list = await routeAnswer(fixture, 'POST', '/replies', assigneeToken, {});
    expect(wireDrift(replyListResponseSchema, list.body)).toEqual([]);

    const confirmed = await routeAnswer(
      fixture,
      'POST',
      '/replies/confirm',
      assigneeToken,
      command({ messageId, disposition: 'follow_up_later' }),
    );
    expect(confirmed.status).toBe(200);
    const result = (confirmed.body as { result: unknown }).result;
    expect(wireDrift(confirmReplyResultSchema, result)).toEqual([]);
    expect(shapeOf(result)).toEqual(shapeOf(confirmReplyResultAnswer()));
  });

  it('is a build the deployed API accepts', () => {
    expect(mayMutate(CONTAINER_CLIENT_VERSIONS, DESKTOP_VERSION_UNDER_TEST)).toBe(true);
  });
});
