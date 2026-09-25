import { afterEach, describe, expect, it } from 'vitest';
import {
  advanceCursor,
  coalesceMailSync,
  fixturePushTokens,
  hoursToSoonestWatchExpiry,
  listMatches,
  listMessagesForOpportunity,
  listWatchesDue,
  pushTokenPolicyOf,
  readCurrentWatch,
  readMailbox,
  readMessageBody,
  receivePushNotification,
  renewWatch,
  resolveAmbiguity,
  runMailRecovery,
  runMailSync,
  type PushTokenClaims,
} from '../../mail/index.ts';
import { listApplicableHolds } from '../../policy/holds.ts';
import { isSuppressed } from '../../suppression/index.ts';
import {
  createMailWorld,
  fixtureMessage,
  seedAnotherFirm,
  PUSH_AUDIENCE,
  PUSH_SERVICE_ACCOUNT,
  TEST_TOPIC_NAME,
  type MailWorld,
  type MailWorldMailbox,
} from './support/mailWorld.ts';

/**
 * The mail half of Appendix G, on a real PostgreSQL with a recorded Gmail fixture.
 *
 * Scenarios 4, 6, 8, 10, 13, 14, 15, 19 and 27, plus the two rules of 12.3 that no
 * numbered scenario states but everything else depends on: only the allowlisted
 * headers are read, and a body is fetched only after a plausible match.
 */

let world: MailWorld | null = null;

afterEach(async () => {
  await world?.stop();
  world = null;
});

/** Finish the baseline recovery a newly connected mailbox starts, so history sync can run. */
async function completeBaseline(w: MailWorld, mailbox: MailWorldMailbox): Promise<void> {
  const context = w.systemContext(mailbox.workspace.workspaceId);
  const outcome = await runMailRecovery(context, w.syncDeps(mailbox), {
    mailboxId: mailbox.mailboxId,
    generation: 1,
  });
  if (outcome.outcome !== 'completed') throw new Error(`the baseline did not complete: ${outcome.outcome}`);
}

const PROSPECT = 'reception@northwind.example.test';

describe('a newly connected mailbox (12.3, 4.2)', () => {
  it('holds every automated step kind for its owner until the baseline proves coverage', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    expect(mailbox?.syncState).toBe('baseline_pending');
    expect(mailbox?.coverageWatermarkAt).toBeNull();

    for (const actionKind of ['email_send', 'call_task', 'enrollment_advance'] as const) {
      const holds = await listApplicableHolds(context, {
        actionKind,
        ownerUserId: w.alpha.workspace.salesperson.userId,
      });
      expect(holds.map(hold => hold.reasonCode), actionKind).toContain('coverage_incomplete');
    }

    await completeBaseline(w, w.alpha);

    const after = await readMailbox(context, w.alpha.mailboxId);
    expect(after?.syncState).toBe('ready');
    expect(after?.coverageWatermarkAt).not.toBeNull();
    const remaining = await listApplicableHolds(context, {
      actionKind: 'email_send',
      ownerUserId: w.alpha.workspace.salesperson.userId,
    });
    expect(remaining.map(hold => hold.reasonCode)).not.toContain('coverage_incomplete');
  });

  it('stores the refresh token as an envelope and nothing that looks like the token', async () => {
    world = await createMailWorld();
    const w = world;
    const { rows } = await w.database.session.query<{
      key_id: string;
      algorithm: string;
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
    }>('SELECT key_id, algorithm, ciphertext, iv, auth_tag FROM mailbox_tokens WHERE mailbox_id = $1', [
      w.alpha.mailboxId,
    ]);
    const row = rows[0];
    expect(row?.algorithm).toBe('aes-256-gcm');
    expect(row?.key_id).toBe('test-envelope');
    expect(row?.iv.length).toBe(12);
    expect(row?.auth_tag.length).toBe(16);
    const plaintext = w.alpha.fixture.refreshToken ?? '';
    expect(row?.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(row?.ciphertext.toString('base64url')).not.toContain(plaintext);
  });
});

describe('metadata first, body only after a match (12.3)', () => {
  it('asks for the header allowlist and nothing else, and fetches no body for an unmatched message', async () => {
    world = await createMailWorld({
      alphaMessages: [
        fixtureMessage({
          id: 'unmatched1',
          historyId: '1001',
          from: 'stranger@elsewhere.example.test',
          to: 'sales.alpha@example.test',
          body: 'Hello, I found your website.',
        }),
      ],
    });
    const w = world;
    await completeBaseline(w, w.alpha);

    expect(w.alpha.gmail.metadataReads).toContain('unmatched1');
    expect(w.alpha.gmail.bodyReads).toEqual([]);
    expect([...w.alpha.gmail.requestedHeaders].sort()).toEqual([
      'Auto-Submitted',
      'Cc',
      'Date',
      'From',
      'In-Reply-To',
      'List-Id',
      'Message-ID',
      'References',
      'Subject',
      'To',
    ]);

    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const { rows } = await w.database.session.query<{ matched: boolean; metadata_only: boolean }>(
      'SELECT matched, metadata_only FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = $2',
      [context.scope.workspaceId, 'unmatched1'],
    );
    expect(rows[0]).toEqual({ matched: false, metadata_only: true });
  });

  it('fetches a body once a participant matches, and never asks for attachment bytes', async () => {
    world = await createMailWorld({
      alphaMessages: [
        fixtureMessage({
          id: 'matched1',
          historyId: '1001',
          from: PROSPECT,
          to: 'sales.alpha@example.test',
          body: 'Can we talk on Tuesday?',
          attachments: [{ filename: 'deck.pdf', mimeType: 'application/pdf', sizeBytes: 1024, attachmentId: 'a1' }],
        }),
      ],
    });
    const w = world;
    await completeBaseline(w, w.alpha);

    expect(w.alpha.gmail.bodyReads).toEqual(['matched1']);
    expect(w.alpha.gmail.calls.some(call => call.method.toLowerCase().includes('attachment'))).toBe(false);

    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const messages = await listMessagesForOpportunity(context, {
      opportunityId: w.crm.alpha.opportunityId,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]?.metadataOnly).toBe(false);
    // 10.3: the reference, not the bytes.
    const { rows } = await w.database.session.query<{ attachment_references: unknown }>(
      'SELECT attachment_references FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = $2',
      [context.scope.workspaceId, 'matched1'],
    );
    expect(rows[0]?.attachment_references).toEqual([
      { filename: 'deck.pdf', mimeType: 'application/pdf', sizeBytes: 1024, attachmentId: 'a1' },
    ]);
  });
});

describe('Appendix G 27: the Pub/Sub webhook', () => {
  async function pushWorld(): Promise<{ readonly w: MailWorld; readonly tokens: ReturnType<typeof fixturePushTokens> }> {
    const created = await createMailWorld();
    return { w: created, tokens: fixturePushTokens() };
  }

  const claimsFor = (nowSeconds: number, overrides: Partial<PushTokenClaims> = {}): PushTokenClaims => ({
    iss: 'https://accounts.google.com',
    aud: PUSH_AUDIENCE,
    email: PUSH_SERVICE_ACCOUNT,
    email_verified: true,
    iat: nowSeconds - 5,
    exp: nowSeconds + 600,
    ...overrides,
  });

  const bodyFor = (address: string, historyId: string, messageId: string): unknown => ({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: address, historyId }), 'utf8').toString('base64'),
      messageId,
      publishTime: '2026-09-11T12:05:00.000Z',
    },
  });

  it('refuses a valid Google signature with the wrong audience or service account, and writes nothing', async () => {
    const { w, tokens } = await pushWorld();
    world = w;
    const now = Math.floor(Date.parse('2026-09-11T12:05:00Z') / 1000);
    const deps = { verifier: tokens.verifier, policy: pushTokenPolicyOf(w.config), now: () => new Date(now * 1000) };

    for (const [label, overrides] of [
      ['audience', { aud: 'https://api.example.test/pubsub/other' }],
      ['service account', { email: 'someone-else@callie-fss.iam.gserviceaccount.test' }],
      ['verification', { email_verified: false }],
      ['expiry', { exp: now - 600 }],
    ] as const) {
      const outcome = await receivePushNotification(w.database.session, deps, {
        token: tokens.sign(claimsFor(now, overrides)),
        body: bodyFor(w.alpha.address, '1005', `push-${label}`),
      });
      expect(outcome.accepted, label).toBe(false);
    }

    const { rows } = await w.database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gmail_push_notifications',
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('refuses a token signed by another key, a missing token and an unknown mailbox', async () => {
    const { w, tokens } = await pushWorld();
    world = w;
    const now = Math.floor(Date.parse('2026-09-11T12:05:00Z') / 1000);
    const deps = { verifier: tokens.verifier, policy: pushTokenPolicyOf(w.config), now: () => new Date(now * 1000) };

    expect(
      await receivePushNotification(w.database.session, deps, {
        token: tokens.signWithAnotherKey(claimsFor(now)),
        body: bodyFor(w.alpha.address, '1005', 'push-forged'),
      }),
    ).toEqual({ accepted: false, refusal: 'signature_invalid' });

    expect(
      await receivePushNotification(w.database.session, deps, {
        token: null,
        body: bodyFor(w.alpha.address, '1005', 'push-none'),
      }),
    ).toEqual({ accepted: false, refusal: 'token_missing' });

    expect(
      await receivePushNotification(w.database.session, deps, {
        token: tokens.sign(claimsFor(now)),
        body: bodyFor('nobody@example.test', '1005', 'push-unknown'),
      }),
    ).toEqual({ accepted: false, refusal: 'mailbox_unknown' });
  });

  it('Appendix G 10: duplicate notifications yield one record and one coalesced sync', async () => {
    const { w, tokens } = await pushWorld();
    world = w;
    const now = Math.floor(Date.parse('2026-09-11T12:05:00Z') / 1000);
    const deps = { verifier: tokens.verifier, policy: pushTokenPolicyOf(w.config), now: () => new Date(now * 1000) };
    const token = tokens.sign(claimsFor(now));

    const first = await receivePushNotification(w.database.session, deps, {
      token,
      body: bodyFor(w.alpha.address, '1005', 'push-duplicate'),
    });
    const second = await receivePushNotification(w.database.session, deps, {
      token,
      body: bodyFor(w.alpha.address, '1007', 'push-duplicate'),
    });

    expect(first.accepted && first.firstDelivery).toBe(true);
    expect(second.accepted && second.firstDelivery).toBe(false);
    expect(first.accepted && second.accepted && first.jobId === second.jobId).toBe(true);

    const notifications = await w.database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM gmail_push_notifications WHERE provider_message_id = $1',
      ['push-duplicate'],
    );
    expect(notifications.rows[0]?.count).toBe('1');

    const jobs = await w.database.session.query<{ count: string; payload: { historyId?: string } }>(
      "SELECT count(*) OVER ()::text AS count, payload FROM jobs WHERE kind = 'mail.sync' AND workspace_id = $1",
      [w.alpha.workspace.workspaceId],
    );
    expect(jobs.rows).toHaveLength(1);
    // The high-water id is merged, never lowered.
    expect(jobs.rows[0]?.payload.historyId).toBe('1007');
  });

  it('Appendix G 8: two workspaces are pushed the same Pub/Sub message id and neither sees the other', async () => {
    const { w, tokens } = await pushWorld();
    world = w;
    const now = Math.floor(Date.parse('2026-09-11T12:05:00Z') / 1000);
    const deps = { verifier: tokens.verifier, policy: pushTokenPolicyOf(w.config), now: () => new Date(now * 1000) };
    const token = tokens.sign(claimsFor(now));

    const alpha = await receivePushNotification(w.database.session, deps, {
      token,
      body: bodyFor(w.alpha.address, '1005', 'push-colliding'),
    });
    const beta = await receivePushNotification(w.database.session, deps, {
      token,
      body: bodyFor(w.beta.address, '1005', 'push-colliding'),
    });

    expect(alpha.accepted && beta.accepted).toBe(true);
    expect(alpha.accepted && beta.accepted && alpha.workspaceId !== beta.workspaceId).toBe(true);

    const { rows } = await w.database.session.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM gmail_push_notifications WHERE provider_message_id = $1 ORDER BY workspace_id',
      ['push-colliding'],
    );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map(row => row.workspace_id)).size).toBe(2);
  });

  it('coalesces the second notification on to the same job and re-arms a finished one', async () => {
    world = await createMailWorld();
    const w = world;
    const first = await coalesceMailSync(w.database.session, {
      workspaceId: w.alpha.workspace.workspaceId,
      mailboxId: w.alpha.mailboxId,
      historyId: '1002',
    });
    expect(first.outcome).toBe('merged');
    await w.database.session.query("UPDATE jobs SET state = 'done', completed_at = now() WHERE id = $1", [
      first.jobId,
    ]);
    const rearmed = await coalesceMailSync(w.database.session, {
      workspaceId: w.alpha.workspace.workspaceId,
      mailboxId: w.alpha.mailboxId,
      historyId: '1003',
    });
    expect(rearmed).toMatchObject({ jobId: first.jobId, outcome: 'rearmed', historyId: '1003' });

    // 13.2: a dead job is revived only by an audited admin command.
    await w.database.session.query("UPDATE jobs SET state = 'dead', dead_at = now() WHERE id = $1", [first.jobId]);
    const dead = await coalesceMailSync(w.database.session, {
      workspaceId: w.alpha.workspace.workspaceId,
      mailboxId: w.alpha.mailboxId,
      historyId: '1004',
    });
    expect(dead.outcome).toBe('dead');
    const { rows } = await w.database.session.query<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [
      first.jobId,
    ]);
    expect(rows[0]?.state).toBe('dead');
  });
});

describe('matching and its consequences', () => {
  it('Appendix G 14: a shared address makes every plausible opportunity a candidate and holds each', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const other = await seedAnotherFirm(w, w.alpha.workspace, {
      name: 'Southwind Test Partners',
      address: PROSPECT,
    });

    w.alpha.messages.push(
      fixtureMessage({
        id: 'shared1',
        historyId: '1010',
        from: PROSPECT,
        to: w.alpha.address,
        body: 'Thanks, who should I speak to?',
      }),
    );
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const report = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(report.outcome).toBe('synced');
    expect(report.ambiguous).toBe(1);

    const { rows } = await w.database.session.query<{ id: string }>(
      'SELECT id FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = $2',
      [context.scope.workspaceId, 'shared1'],
    );
    const messageId = rows[0]?.id ?? '';
    const matches = await listMatches(context, messageId);
    expect(matches).toHaveLength(2);
    expect(matches.every(match => match.ambiguous && match.holdId !== null)).toBe(true);
    expect(new Set(matches.map(match => match.opportunityId))).toEqual(
      new Set([w.crm.alpha.opportunityId, other.opportunityId]),
    );

    // Resolution releases only the loser's ambiguity hold; the winner stays held.
    const resolved = await resolveAmbiguity(w.userContext(w.alpha.workspace.workspaceId), {
      messageId,
      selectedOpportunityId: w.crm.alpha.opportunityId,
      human: true,
    });
    expect(resolved.ok).toBe(true);

    const loserHolds = await listApplicableHolds(context, {
      actionKind: 'email_send',
      opportunityId: other.opportunityId,
    });
    expect(loserHolds.map(hold => hold.reasonCode)).not.toContain('ambiguous_match');

    const winnerHolds = await listApplicableHolds(context, {
      actionKind: 'email_send',
      opportunityId: w.crm.alpha.opportunityId,
    });
    expect(winnerHolds.length).toBeGreaterThan(0);

    const control = await w.database.session.query<{ control_mode: string }>(
      'SELECT control_mode FROM opportunities WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, w.crm.alpha.opportunityId],
    );
    expect(control.rows[0]?.control_mode).toBe('manual');
  });

  it('Appendix G 15: a reply on a closed opportunity holds the firm’s current open one', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    // Close the seeded opportunity and open a new one for the same firm.
    await w.database.session.query(
      `UPDATE opportunities SET status = 'lost', closed_at = now(), close_reason = 'no response'
        WHERE workspace_id = $1 AND id = $2`,
      [context.scope.workspaceId, w.crm.alpha.opportunityId],
    );
    const stage = await w.database.session.query<{ id: string }>(
      'SELECT id FROM pipeline_stages WHERE workspace_id = $1 ORDER BY position LIMIT 1',
      [context.scope.workspaceId],
    );
    const reopened = await w.database.session.query<{ id: string }>(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
       VALUES ($1, $2, $3, now()) RETURNING id`,
      [context.scope.workspaceId, w.crm.alpha.firmId, stage.rows[0]?.id],
    );
    const openOpportunityId = reopened.rows[0]?.id ?? '';

    w.alpha.messages.push(
      fixtureMessage({
        id: 'closed1',
        historyId: '1011',
        from: PROSPECT,
        to: w.alpha.address,
        body: 'Sorry for the slow reply, can we pick this up?',
      }),
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });

    const holds = await listApplicableHolds(context, {
      actionKind: 'email_send',
      opportunityId: openOpportunityId,
    });
    expect(holds.map(hold => hold.reasonCode)).toContain('uncertain_reply');
  });

  it('Appendix G 19: a direct Gmail send switches an automated firm to manual, once', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    w.alpha.messages.push(
      fixtureMessage({
        id: 'direct1',
        historyId: '1012',
        from: w.alpha.address,
        to: PROSPECT,
        labelIds: ['SENT'],
        body: 'Following up directly.',
      }),
    );

    const first = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(first.directSendsSwitchedToManual).toBe(1);

    // Import the same message again — a duplicate push, a reconciliation pass.
    await w.database.session.query(
      "UPDATE mailboxes SET history_id = '1011' WHERE workspace_id = $1 AND id = $2",
      [context.scope.workspaceId, w.alpha.mailboxId],
    );
    const second = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(second.directSendsSwitchedToManual).toBe(0);

    const { rows } = await w.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM mail_message_effects
        WHERE workspace_id = $1 AND effect_kind = 'direct_send_manual'`,
      [context.scope.workspaceId],
    );
    expect(rows[0]?.count).toBe('1');

    const events = await w.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_domain_events
        WHERE workspace_id = $1 AND event_kind = 'opportunity.manual_mode'`,
      [context.scope.workspaceId],
    );
    expect(events.rows[0]?.count).toBe('1');

    // No body was fetched for an outgoing message: 12.3 matches it, it does not read it.
    expect(w.alpha.gmail.bodyReads).not.toContain('direct1');
  });
});

describe('deterministic classification effects (12.4)', () => {
  it('Appendix G 6: explicit opt-out language suppresses the address and the unambiguous firm at once', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    w.alpha.messages.push(
      fixtureMessage({
        id: 'optout1',
        historyId: '1013',
        from: PROSPECT,
        to: w.alpha.address,
        body: 'Please stop emailing me.',
      }),
    );
    const report = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(report.suppressionsRecorded).toBe(2);

    expect(await isSuppressed(context, { scope: 'handle', canonicalKey: PROSPECT })).not.toBeNull();
    expect(await isSuppressed(context, { scope: 'firm', canonicalKey: w.crm.alpha.firmId })).not.toBeNull();
    // 10.2: the journal write precedes the row.
    expect(w.journal.appended.length).toBe(2);

    // The other workspace's identical address is untouched (Appendix G 8).
    const betaContext = w.systemContext(w.beta.workspace.workspaceId);
    expect(await isSuppressed(betaContext, { scope: 'handle', canonicalKey: PROSPECT })).toBeNull();
  });

  it('holds an uncertain reply for every candidate and promotes the reply lane in the same transaction', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    w.alpha.messages.push(
      fixtureMessage({
        id: 'reply1',
        historyId: '1014',
        from: PROSPECT,
        to: w.alpha.address,
        body: 'What does this cost and how does the integration work?',
      }),
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });

    const holds = await listApplicableHolds(context, {
      actionKind: 'email_send',
      opportunityId: w.crm.alpha.opportunityId,
    });
    expect(holds.map(hold => hold.reasonCode)).toContain('uncertain_reply');

    expect(w.replyPromoter.promotions).toHaveLength(1);
    expect(w.replyPromoter.promotions[0]).toMatchObject({ firmId: w.crm.alpha.firmId });

    const classification = await w.database.session.query<{ layer: string; class: string; rules_version: string }>(
      `SELECT c.layer, c.class, c.rules_version
         FROM mail_message_classifications AS c
         JOIN mail_messages AS m ON m.workspace_id = c.workspace_id AND m.id = c.mail_message_id
        WHERE m.provider_message_id = $1 AND m.workspace_id = $2`,
      ['reply1', context.scope.workspaceId],
    );
    expect(classification.rows[0]).toMatchObject({ layer: 'deterministic', class: 'uncertain' });
  });

  it('does not retain an out-of-office body, and keeps the rule that fired', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    w.alpha.messages.push(
      fixtureMessage({
        id: 'ooo1',
        historyId: '1015',
        from: PROSPECT,
        to: w.alpha.address,
        subject: 'Automatic reply',
        body: 'I am out of the office until Monday and will reply then.',
      }),
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });

    const { rows } = await w.database.session.query<{ id: string }>(
      'SELECT id FROM mail_messages WHERE workspace_id = $1 AND provider_message_id = $2',
      [context.scope.workspaceId, 'ooo1'],
    );
    const messageId = rows[0]?.id ?? '';
    expect(await readMessageBody(context, messageId)).toBeNull();

    const classification = await w.database.session.query<{ class: string; signals: { rule: string }[] }>(
      'SELECT class, signals FROM mail_message_classifications WHERE workspace_id = $1 AND mail_message_id = $2',
      [context.scope.workspaceId, messageId],
    );
    expect(classification.rows[0]?.class).toBe('automated');
    expect(classification.rows[0]?.signals.map(signal => signal.rule)).toContain('vacation_pattern');
  });

  it('a bounce invalidates the prospect route and never the reporting daemon’s address', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    // The daemon is also a route on the same firm, which is the case the rule exists for.
    await w.database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility, eligibility_policy_version)
       VALUES ($1, $2, 'mailer-daemon@northwind.example.test', 'research_provider',
               TIMESTAMPTZ '2026-09-01 12:00:00+00', 0.9, 'passed', 'usable', 'route-policy.1')`,
      [context.scope.workspaceId, w.crm.alpha.firmId],
    );

    w.alpha.messages.push(
      fixtureMessage({
        id: 'bounce1',
        historyId: '1016',
        from: 'mailer-daemon@northwind.example.test',
        to: w.alpha.address,
        subject: 'Delivery Status Notification (Failure)',
        body: 'Delivery has failed to these recipients: address not found.',
      }),
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });

    const { rows } = await w.database.session.query<{ address: string; eligibility: string }>(
      'SELECT address, eligibility FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2 ORDER BY address',
      [context.scope.workspaceId, w.crm.alpha.firmId],
    );
    const byAddress = new Map(rows.map(row => [row.address, row.eligibility]));
    expect(byAddress.get('mailer-daemon@northwind.example.test')).toBe('usable');
    expect(byAddress.get(PROSPECT)).toBe('invalid');

    const effects = await w.database.session.query<{ detail: { stepResult?: string } }>(
      `SELECT detail FROM mail_message_effects WHERE workspace_id = $1 AND effect_kind = 'route_invalidated'`,
      [context.scope.workspaceId],
    );
    expect(effects.rows[0]?.detail.stepResult).toBe('no_email');
  });
});

describe('coverage, recovery and the grant', () => {
  it('Appendix G 4: a revoked grant marks the mailbox and holds every automated step kind', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    const gmail = w.clientWith(w.alpha, { grantRevoked: true });
    const report = await runMailSync(context, { ...w.syncDeps(w.alpha), gmail }, {
      mailboxId: w.alpha.mailboxId,
    });
    expect(report.outcome).toBe('grant_revoked');

    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    expect(mailbox?.status).toBe('revoked');

    for (const actionKind of ['email_send', 'call_task', 'enrollment_advance'] as const) {
      const holds = await listApplicableHolds(context, {
        actionKind,
        ownerUserId: w.alpha.workspace.salesperson.userId,
      });
      expect(holds.map(hold => hold.reasonCode), actionKind).toContain('mailbox_disconnected');
    }
  });

  it('Appendix G 13: an expired cursor recovers by overlap and clears the hold only on proof', async () => {
    const justOutside = Date.parse('2026-09-11T11:30:00Z');
    world = await createMailWorld({
      alphaMessages: [
        fixtureMessage({
          id: 'outside1',
          historyId: '999',
          from: PROSPECT,
          to: 'sales.alpha@example.test',
          body: 'Are you free Thursday?',
          internalDateEpochMilliseconds: justOutside,
        }),
      ],
    });
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    const before = await readMailbox(context, w.alpha.mailboxId);
    expect(before?.generation).toBe(1);

    // The cursor Gmail will refuse.
    const gmail = w.clientWith(w.alpha, { expiredHistoryIds: [before?.historyId ?? ''] });
    const report = await runMailSync(context, { ...w.syncDeps(w.alpha), gmail }, {
      mailboxId: w.alpha.mailboxId,
    });
    expect(report.outcome).toBe('recovery_started');

    const recovering = await readMailbox(context, w.alpha.mailboxId);
    expect(recovering?.syncState).toBe('recovering');
    expect(recovering?.generation).toBe(2);
    expect(
      (await listApplicableHolds(context, {
        actionKind: 'email_send',
        ownerUserId: w.alpha.workspace.salesperson.userId,
      })).map(hold => hold.reasonCode),
    ).toContain('coverage_incomplete');

    const recovery = await w.database.session.query<{ from_at: Date; to_at: Date }>(
      'SELECT from_at, to_at FROM mailbox_recoveries WHERE workspace_id = $1 AND generation = 2',
      [context.scope.workspaceId],
    );
    const fromAt = recovery.rows[0]?.from_at.getTime() ?? 0;
    // Watermark minus one hour: the reply just outside the nominal bound is inside it.
    expect(fromAt).toBeLessThanOrEqual(justOutside);

    const finished = await runMailRecovery(context, { ...w.syncDeps(w.alpha), gmail }, {
      mailboxId: w.alpha.mailboxId,
      generation: 2,
    });
    expect(finished.outcome).toBe('completed');
    expect(finished.coverageProved).toBe(true);

    const after = await readMailbox(context, w.alpha.mailboxId);
    expect(after?.syncState).toBe('ready');
    expect(
      (await listApplicableHolds(context, {
        actionKind: 'email_send',
        ownerUserId: w.alpha.workspace.salesperson.userId,
      })).map(hold => hold.reasonCode),
    ).not.toContain('coverage_incomplete');
  });

  it('refuses to advance a cursor another run has already moved', async () => {
    world = await createMailWorld({
      alphaMessages: [
        fixtureMessage({
          id: 'race1',
          historyId: '1020',
          from: PROSPECT,
          to: 'sales.alpha@example.test',
          body: 'Hello again.',
        }),
      ],
    });
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);

    // Another run moved the cursor while this one was reading.
    const mailbox = await readMailbox(context, w.alpha.mailboxId);
    const stale = mailbox?.historyId ?? null;
    await advanceCursor(context, {
      mailboxId: w.alpha.mailboxId,
      expectedHistoryId: stale,
      historyId: '9999',
    });
    const outcome = await advanceCursor(context, {
      mailboxId: w.alpha.mailboxId,
      expectedHistoryId: stale,
      historyId: '8888',
    });
    expect(outcome).toEqual({ advanced: false, reason: 'cursor_moved' });
  });
});

describe('the Gmail watch (12.3, 13.3)', () => {
  it('renews with a new generation, keeps one current watch, and reports hours to expiry', async () => {
    world = await createMailWorld();
    const w = world;
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const deps = {
      ...w.syncDeps(w.alpha),
      topicName: TEST_TOPIC_NAME,
    };

    const first = await renewWatch(context, deps, { mailboxId: w.alpha.mailboxId, generation: 1 });
    expect(first.outcome).toBe('renewed');
    const second = await renewWatch(context, deps, { mailboxId: w.alpha.mailboxId, generation: 2 });
    expect(second.outcome).toBe('renewed');
    // A renewal that waited through another one writes nothing.
    const stale = await renewWatch(context, deps, { mailboxId: w.alpha.mailboxId, generation: 2 });
    expect(stale.outcome).toBe('generation_superseded');

    const current = await readCurrentWatch(context, w.alpha.mailboxId);
    expect(current?.generation).toBe(2);
    const { rows } = await w.database.session.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM mailbox_watches WHERE workspace_id = $1 AND cancelled_at IS NULL',
      [context.scope.workspaceId],
    );
    expect(rows[0]?.count).toBe('1');

    const hours = await hoursToSoonestWatchExpiry(w.database.session);
    // The beta mailbox has no watch at all, which is the state the alarm fires on.
    expect(hours).toBe(0);

    const due = await listWatchesDue(w.database.session, new Date('2026-09-11T12:00:00Z').toISOString());
    expect(due.map(row => row.mailboxId)).toContain(w.beta.mailboxId);
    expect(due.find(row => row.mailboxId === w.beta.mailboxId)?.generation).toBe(1);
  });
});

/**
 * What the import tells 12.7's ramp (lane G15).
 *
 * G7-2 built `countDirectSend` and `recordDaySignal` and no caller. The counters they
 * write are the whole of `rampHealthFailure`'s evidence, so until this lane every day
 * was judged on zeros and `mailbox_send_days.direct_sent` was always zero however much
 * a salesperson sent by hand.
 *
 * Every instant below comes from the clock. The business date is read back from
 * PostgreSQL in the workspace's own zone, which is where `mailbox_send_days` keeps its
 * calendar (migration 0010), and not from `Intl` on this host.
 */
describe('the import feeds the reputation ramp (12.7)', () => {
  /** The workspace business date of an instant, PostgreSQL's answer and no other. */
  const businessDateOfInstant = async (w: MailWorld, workspaceId: string, instant: string): Promise<string> => {
    const { rows } = await w.database.session.query<{ date: string }>(
      `SELECT (($2::timestamptz AT TIME ZONE business_time_zone)::date)::text AS date
         FROM workspaces WHERE id = $1`,
      [workspaceId, instant],
    );
    const date = rows[0]?.date;
    if (date === undefined) throw new Error('the workspace has no business zone');
    return date;
  };

  const day = async (
    w: MailWorld,
    workspaceId: string,
    mailboxId: string,
    businessDate: string,
  ): Promise<{ automated_sent: number; direct_sent: number; bounces: number; opt_outs: number } | undefined> => {
    const { rows } = await w.database.session.query<{
      automated_sent: number;
      direct_sent: number;
      bounces: number;
      opt_outs: number;
    }>(
      `SELECT automated_sent, direct_sent, bounces, opt_outs FROM mailbox_send_days
        WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
      [workspaceId, mailboxId, businessDate],
    );
    return rows[0];
  };

  it('counts an imported direct send against the day, once however often it is imported', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const sentAt = Date.now();

    w.alpha.messages.push(
      fixtureMessage({
        id: 'headroom1',
        historyId: '1200',
        from: w.alpha.address,
        to: PROSPECT,
        labelIds: ['SENT'],
        internalDateEpochMilliseconds: sentAt,
      }),
    );

    const first = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(first.directSendsCounted).toBe(1);
    expect(first.automatedSendsRecognised).toBe(0);

    const businessDate = await businessDateOfInstant(
      w,
      context.scope.workspaceId,
      new Date(sentAt).toISOString(),
    );
    const counted = await day(w, context.scope.workspaceId, w.alpha.mailboxId, businessDate);
    expect(counted?.direct_sent).toBe(1);
    // 12.7: a direct send is never counted against the automated cap, because the cap
    // is FSS's own restraint and a person writing their own email is not FSS.
    expect(counted?.automated_sent).toBe(0);

    // The same message again — a duplicate push, a recovery pass. `recordMessage`
    // inserts nothing, so nothing is counted.
    await w.database.session.query(
      "UPDATE mailboxes SET history_id = '1199' WHERE workspace_id = $1 AND id = $2",
      [context.scope.workspaceId, w.alpha.mailboxId],
    );
    const second = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(second.directSendsCounted).toBe(0);
    const again = await day(w, context.scope.workspaceId, w.alpha.mailboxId, businessDate);
    expect(again?.direct_sent).toBe(1);

    // And nothing reached the other workspace's mailbox.
    const betaDay = await day(w, w.beta.workspace.workspaceId, w.beta.mailboxId, businessDate);
    expect(betaDay).toBeUndefined();
  });

  it('recognises its own send by its fence, and neither counts it nor makes the firm manual', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const sentAt = Date.now();
    const rfcMessageId = 'fss.11111111-2222-4333-8444-555555555555@example.test';

    // The fence FSS wrote before it sent, with the deterministic Message-ID the
    // provider then echoes back through the sync. `draft` origin, because this test is
    // about the header and not about a step execution.
    await w.database.session.query(
      `INSERT INTO outbound_messages
         (workspace_id, mailbox_id, origin_kind, draft_id, firm_id, recipient_address,
          subject, body, rendered_hash, provider_message_id_header, send_at, source_zone,
          placement_rule_version)
       VALUES ($1, $2, 'draft', gen_random_uuid(), $3, $4, 'A short note',
               'A body with a stop line.', repeat('a', 64), $5, now(), 'UTC', 'email-window.1')`,
      [context.scope.workspaceId, w.alpha.mailboxId, w.crm.alpha.firmId, PROSPECT, `<${rfcMessageId}>`],
    );

    w.alpha.messages.push(
      fixtureMessage({
        id: 'fsssend1',
        historyId: '1210',
        from: w.alpha.address,
        to: PROSPECT,
        labelIds: ['SENT'],
        messageId: rfcMessageId,
        internalDateEpochMilliseconds: sentAt,
      }),
    );

    const report = await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect(report.automatedSendsRecognised).toBe(1);
    // Counted once, at dispatch, by `countAutomatedSend`. A second count here would
    // double every sequence email in the day's headroom.
    expect(report.directSendsCounted).toBe(0);
    // 7.3 reserves manual mode for a *direct* send. Switching here would terminally
    // stop the enrollment that had just sent step one.
    expect(report.directSendsSwitchedToManual).toBe(0);

    const events = await w.database.session.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM crm_domain_events
        WHERE workspace_id = $1 AND event_kind = 'opportunity.manual_mode'`,
      [context.scope.workspaceId],
    );
    expect(events.rows[0]?.count).toBe('0');

    const businessDate = await businessDateOfInstant(
      w,
      context.scope.workspaceId,
      new Date(sentAt).toISOString(),
    );
    expect(await day(w, context.scope.workspaceId, w.alpha.mailboxId, businessDate)).toBeUndefined();
  });

  it('records a bounce and an opt-out against the day the ramp reads', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const arrivedAt = Date.now();
    const businessDate = await businessDateOfInstant(
      w,
      context.scope.workspaceId,
      new Date(arrivedAt).toISOString(),
    );

    // A sending day the mailbox opened by sending. `recordDaySignal` is a bare
    // `UPDATE`, deliberately: a day with no automated sends is not a sending day, so
    // there is nothing for a bounce to be a proportion of.
    await w.database.session.query(
      `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, cap_granted)
       VALUES ($1, $2, $3::date, 4, 5)`,
      [context.scope.workspaceId, w.alpha.mailboxId, businessDate],
    );

    // The opt-out first, because the bounce invalidates the prospect's route and a
    // reply arriving afterwards has nothing left to match on.
    w.alpha.messages.push(
      fixtureMessage({
        id: 'rampoptout1',
        historyId: '1220',
        from: PROSPECT,
        to: w.alpha.address,
        body: 'Please stop emailing me.',
        internalDateEpochMilliseconds: arrivedAt,
      }),
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });

    // The daemon is a route on the same firm, which is how a bounce report matches at
    // all — the same fixture the route-invalidation scenario above uses.
    await w.database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility,
                                    eligibility_policy_version)
       VALUES ($1, $2, 'mailer-daemon@northwind.example.test', 'research_provider',
               now(), 0.9, 'passed', 'usable', 'route-policy.1')`,
      [context.scope.workspaceId, w.crm.alpha.firmId],
    );
    w.alpha.messages.push(
      fixtureMessage({
        id: 'rampbounce1',
        historyId: '1221',
        from: 'mailer-daemon@northwind.example.test',
        to: w.alpha.address,
        subject: 'Delivery Status Notification (Failure)',
        body: 'Delivery has failed to these recipients: address not found.',
        internalDateEpochMilliseconds: arrivedAt,
      }),
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });

    const counted = await day(w, context.scope.workspaceId, w.alpha.mailboxId, businessDate);
    expect(counted?.opt_outs).toBe(1);
    expect(counted?.bounces).toBe(1);

    // Twice is once: the `mail_message_effects` uniqueness that makes each effect
    // happen once is the same guard the count sits behind.
    await w.database.session.query(
      "UPDATE mailboxes SET history_id = '1219' WHERE workspace_id = $1 AND id = $2",
      [context.scope.workspaceId, w.alpha.mailboxId],
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    const again = await day(w, context.scope.workspaceId, w.alpha.mailboxId, businessDate);
    expect(again?.bounces).toBe(1);
    expect(again?.opt_outs).toBe(1);
  });

  /**
   * A bounce that arrives after its send day closed (12.7, lane G22, the G15
   * follow-up).
   *
   * G15 counted every bounce against the day it *arrived* and recorded the cost in
   * `docs/decisions/g15-the-worker-drains-what-the-lanes-left.md`: "a bounce for
   * yesterday's send, arriving after yesterday's day has been closed, is not counted
   * against it". A bounce is a fact about the send that caused it, and 12.7's
   * threshold is a proportion of *that day's* automated sends, so counting it on the
   * day the report happened to land both understates yesterday and slanders today.
   *
   * The report names the send in its `References`, the fence holds the deterministic
   * Message-ID and the business date the cap counted the send against, and the two
   * join. Twenty sends is `RAMP_RATE_FLOOR`, so the day is judged on its rate: one
   * bounce is exactly five per cent, which `RAMP_MAX_BOUNCE_RATE` does not exceed, and
   * two is ten, which it does.
   */
  it('attributes a late bounce to the send day that caused it, and takes the ramp back only when it crosses the threshold', async () => {
    world = await createMailWorld();
    const w = world;
    await completeBaseline(w, w.alpha);
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    const workspaceId = context.scope.workspaceId;
    const arrivedAt = Date.now();
    const today = await businessDateOfInstant(w, workspaceId, new Date(arrivedAt).toISOString());
    const { rows: dates } = await w.database.session.query<{ date: string }>(
      `SELECT ($2::date - 1)::text AS date FROM workspaces WHERE id = $1`,
      [workspaceId, today],
    );
    const yesterday = dates[0]?.date ?? '';
    expect(yesterday).not.toBe('');

    // Yesterday: twenty automated sends, closed, judged healthy, and a ramp that
    // counted the day.
    await w.database.session.query(
      `INSERT INTO mailbox_send_days
         (workspace_id, mailbox_id, business_date, automated_sent, cap_granted, healthy, closed_at)
       VALUES ($1, $2, $3::date, 20, 50, true, now() - interval '1 hour')`,
      [workspaceId, w.alpha.mailboxId, yesterday],
    );
    await w.database.session.query(
      `INSERT INTO mailbox_send_ramp (workspace_id, mailbox_id, healthy_sending_days, last_advanced_on)
       VALUES ($1, $2, 6, $3::date)`,
      [workspaceId, w.alpha.mailboxId, yesterday],
    );
    // Today, still open. A bounce counted on the day it arrived would land here, so
    // this row is what makes the misattribution visible rather than invisible.
    await w.database.session.query(
      `INSERT INTO mailbox_send_days (workspace_id, mailbox_id, business_date, automated_sent, cap_granted)
       VALUES ($1, $2, $3::date, 4, 50)`,
      [workspaceId, w.alpha.mailboxId, today],
    );

    const headers = [
      'fss.aaaaaaaa-1111-4111-8111-111111111111@example.test',
      'fss.bbbbbbbb-2222-4222-8222-222222222222@example.test',
    ];
    for (const header of headers) {
      await w.database.session.query(
        `INSERT INTO outbound_messages
           (workspace_id, mailbox_id, origin_kind, draft_id, firm_id, recipient_address,
            subject, body, rendered_hash, provider_message_id_header, send_at, source_zone,
            placement_rule_version, business_date)
         VALUES ($1, $2, 'draft', gen_random_uuid(), $3, $4, 'A short note',
                 'A body with a stop line.', repeat('a', 64), $5, now() - interval '1 day',
                 'UTC', 'email-window.1', $6::date)`,
        [workspaceId, w.alpha.mailboxId, w.crm.alpha.firmId, PROSPECT, `<${header}>`, yesterday],
      );
    }

    // The daemon is a route on the same firm, which is how a report matches at all.
    await w.database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, address, source, retrieved_at,
                                    association_confidence, technical_validation, eligibility,
                                    eligibility_policy_version)
       VALUES ($1, $2, 'mailer-daemon@northwind.example.test', 'research_provider',
               now(), 0.9, 'passed', 'usable', 'route-policy.1')`,
      [workspaceId, w.crm.alpha.firmId],
    );

    const ramp = async (): Promise<{ healthy_sending_days: number; last_health_failure: string | null }> => {
      const { rows } = await w.database.session.query<{
        healthy_sending_days: number;
        last_health_failure: string | null;
      }>(
        `SELECT healthy_sending_days, last_health_failure FROM mailbox_send_ramp
          WHERE workspace_id = $1 AND mailbox_id = $2`,
        [workspaceId, w.alpha.mailboxId],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('the mailbox has no ramp');
      return row;
    };
    const verdict = async (businessDate: string): Promise<boolean | null> => {
      const { rows } = await w.database.session.query<{ healthy: boolean | null }>(
        `SELECT healthy FROM mailbox_send_days
          WHERE workspace_id = $1 AND mailbox_id = $2 AND business_date = $3::date`,
        [workspaceId, w.alpha.mailboxId, businessDate],
      );
      return rows[0]?.healthy ?? null;
    };

    const bounce = async (id: string, historyId: string, reference: string): Promise<void> => {
      w.alpha.messages.push(
        fixtureMessage({
          id,
          historyId,
          from: 'mailer-daemon@northwind.example.test',
          to: w.alpha.address,
          subject: 'Delivery Status Notification (Failure)',
          body: 'Delivery has failed to these recipients: address not found.',
          references: [reference],
          internalDateEpochMilliseconds: arrivedAt,
        }),
      );
      await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    };

    await bounce('latebounce1', '1230', headers[0] ?? '');

    // Counted against the send, not against the morning it was read.
    expect((await day(w, workspaceId, w.alpha.mailboxId, yesterday))?.bounces).toBe(1);
    expect((await day(w, workspaceId, w.alpha.mailboxId, today))?.bounces).toBe(0);
    // One in twenty is exactly five per cent, and five per cent is not more than five
    // per cent: the day stands and the ramp keeps what it earned.
    expect(await verdict(yesterday)).toBe(true);
    expect((await ramp()).healthy_sending_days).toBe(6);
    expect((await ramp()).last_health_failure).toBeNull();

    await bounce('latebounce2', '1231', headers[1] ?? '');

    expect((await day(w, workspaceId, w.alpha.mailboxId, yesterday))?.bounces).toBe(2);
    expect((await day(w, workspaceId, w.alpha.mailboxId, today))?.bounces).toBe(0);
    // Ten per cent. The day was never healthy, so the ramp gives back the day it
    // counted on the strength of it.
    expect(await verdict(yesterday)).toBe(false);
    expect((await ramp()).healthy_sending_days).toBe(5);
    expect((await ramp()).last_health_failure).toBe('bounce_rate');

    // Once, however often the bounce is re-imported: the effect's own uniqueness is
    // the guard, and the day is not taken back a second time.
    await w.database.session.query(
      "UPDATE mailboxes SET history_id = '1229' WHERE workspace_id = $1 AND id = $2",
      [workspaceId, w.alpha.mailboxId],
    );
    await runMailSync(context, w.syncDeps(w.alpha), { mailboxId: w.alpha.mailboxId });
    expect((await day(w, workspaceId, w.alpha.mailboxId, yesterday))?.bounces).toBe(2);
    expect((await ramp()).healthy_sending_days).toBe(5);

    // Nothing reached the other workspace, which holds the same firm and address.
    expect(await day(w, w.beta.workspace.workspaceId, w.beta.mailboxId, yesterday)).toBeUndefined();
  });
});
