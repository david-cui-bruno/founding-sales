import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { recordMatches } from '@fss/domain/mail/matching.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * Who may name the firm of a held outgoing message (send-path v2, S1 review P1-E).
 *
 * Resolving the salesperson's own e-mail to a firm ends that firm's prospecting and
 * spends its one-message permissions, so it is authorized like any other change to the
 * firm: the mailbox's owner, and only for a firm the PR 332 assignment rule lets them
 * change. Single-user today; the rule holds anyway. Every name and address is invented
 * (`example.test`, RFC 6761).
 */
describe('resolving a held outgoing message across two assignees', () => {
  let fixture: AuthFixture;
  let ownerToken: string;

  const options = () => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
  });

  const post = async (path: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = {
      method: 'POST',
      path,
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${token}` },
      body,
    };
    const result = await dispatch(request, options());
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };

  const openOpportunity = async (firmId: string): Promise<string> => {
    const { rows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1), now())
       RETURNING id`,
      [fixture.alpha.workspaceId, firmId],
    );
    return rows[0]?.id ?? '';
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    ownerToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('refuses a firm the owner is not assigned to, and changes nothing', async () => {
    const otherSub = `sub-${randomUUID()}`;
    const { rows: other } = await fixture.db.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ($1, $2, 'Other Seller') RETURNING id",
      [otherSub, `other-seller@${fixture.hostedDomain}`],
    );
    const otherUserId = other[0]?.id ?? '';
    await fixture.db.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [fixture.alpha.workspaceId, otherUserId],
    );
    const firmA = await seedFirm(fixture, { name: 'Northwind Test Holdings', assignedUserId: fixture.alpha.salesperson.userId });
    const firmB = await seedFirm(fixture, { name: 'Southwind Test Partners', assignedUserId: otherUserId });
    const contactA = await seedContact(fixture, { firmId: firmA, fullName: 'Dana Example', isPrimary: true });
    const contactB = await seedContact(fixture, { firmId: firmB, fullName: 'Pat Example', isPrimary: true });
    const opportunityA = await openOpportunity(firmA);
    const opportunityB = await openOpportunity(firmB);

    const { rows: mailbox } = await fixture.db.query<{ id: string }>(
      `INSERT INTO mailboxes (workspace_id, owner_user_id, email_address, provider_account_id, status)
       VALUES ($1, $2, 'seller@example.test', 'seller-account', 'connected') RETURNING id`,
      [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId],
    );
    const { rows: message } = await fixture.db.query<{ id: string }>(
      `INSERT INTO mail_messages
         (workspace_id, mailbox_id, provider_message_id, provider_thread_id, direction,
          internal_date, header_from, header_to, matched)
       VALUES ($1, $2, 'held-out-1', 'held-thread-1', 'outgoing', now(), 'seller@example.test',
               ARRAY['shared@example.test'], true)
       RETURNING id`,
      [fixture.alpha.workspaceId, mailbox[0]?.id ?? ''],
    );
    const messageId = message[0]?.id ?? '';
    const system = repositoryContext(
      workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }),
      fixture.db,
    );
    const held = await recordMatches(system, {
      messageId,
      candidates: [
        { firmId: firmA, opportunityId: opportunityA, contactId: contactA, rule: 'participant', viaClosedOpportunity: false },
        { firmId: firmB, opportunityId: opportunityB, contactId: contactB, rule: 'participant', viaClosedOpportunity: false },
      ],
    });
    expect(held.holdIds).toHaveLength(2);

    const refused = await post('/messages/resolve-ambiguity', ownerToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      messageId,
      selectedOpportunityId: opportunityB,
      human: false,
    });
    expect(refused.body['reason'], JSON.stringify(refused.body)).toBe('not_assigned');

    const { rows: matches } = await fixture.db.query<{ selected: boolean | null }>(
      'SELECT selected FROM mail_message_matches WHERE workspace_id = $1 AND mail_message_id = $2',
      [fixture.alpha.workspaceId, messageId],
    );
    expect(matches.map(row => row.selected)).toEqual([null, null]);
    const { rows: holds } = await fixture.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM active_holds WHERE workspace_id = $1 AND id = ANY ($2::uuid[]) AND released_at IS NULL',
      [fixture.alpha.workspaceId, [...held.holdIds]],
    );
    expect(holds[0]?.count).toBe('2');
    const { rows: effects } = await fixture.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mail_message_effects WHERE workspace_id = $1 AND mail_message_id = $2',
      [fixture.alpha.workspaceId, messageId],
    );
    expect(effects[0]?.count).toBe('0');

    // The firm the owner is assigned to is theirs to name.
    const chosen = await post('/messages/resolve-ambiguity', ownerToken, {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      messageId,
      selectedOpportunityId: opportunityA,
      human: false,
    });
    expect(chosen.status, JSON.stringify(chosen.body)).toBe(200);
    const { rows: applied } = await fixture.db.query<{ firm_id: string }>(
      `SELECT detail->>'firmId' AS firm_id FROM mail_message_effects
        WHERE workspace_id = $1 AND mail_message_id = $2 AND effect_kind = 'direct_send_conversation'`,
      [fixture.alpha.workspaceId, messageId],
    );
    expect(applied).toEqual([{ firm_id: firmA }]);
  });
});
