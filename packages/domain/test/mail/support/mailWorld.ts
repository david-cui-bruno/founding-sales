import { randomBytes } from 'node:crypto';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../../db/workspaceScope.ts';
import { createTestDatabase, type TestDatabase } from '../../../db/testing/testDatabase.ts';
import { seedTwoWorkspaces, type SeededWorkspace, type TwoWorkspaces } from '../../db/support/fixtures.ts';
import { seedCrm, firstStageId, type SeededCrm } from '../../db/support/crmFixtures.ts';
import { recordingSuppressionJournal, type RecordingSuppressionJournal } from '../../../suppression/journal.ts';
import { type MailPublicConfig } from '../../../mail/config.ts';
import { localEnvelopeCipher, type EnvelopeCipher } from '../../../mail/envelope.ts';
import {
  recordedGmailClient,
  type GmailFixture,
  type GmailFixtureMessage,
  type RecordedGmailClient,
} from '../../../mail/gmailClientFake.ts';
import { completeGmailGrant, signGrantState } from '../../../mail/oauth.ts';
import { recordingReplyPromoter } from '../../../mail/replyLane.ts';
import { staticSecretProvider } from '../../../mail/secretProvider.ts';
import { type MailSyncDeps } from '../../../mail/sync.ts';

/**
 * One connected mailbox in each of two workspaces, on a real PostgreSQL, with a
 * recorded Gmail fixture behind it.
 *
 * Every test in this directory starts here, and the two-workspace half is not
 * decoration: the same Gmail message id, thread id, RFC Message-ID and Pub/Sub message
 * id exist in both workspaces, so every assertion about one is also an assertion that
 * the other did not move (specification 6, Appendix G 8).
 *
 * Nothing here is a credential. The OAuth client secret, the state-signing key and
 * the envelope master key are generated with `randomBytes` when the world is built,
 * and the refresh token the fixture hands back is generated the same way. No literal
 * in this file could be mistaken for one.
 *
 * No real person, address or business name either: `example.test` is reserved by RFC
 * 6761 and every name is obviously invented.
 */

export const TEST_TOPIC_NAME = 'projects/callie-fss/topics/fss-test-gmail-push';
export const PUSH_AUDIENCE = 'https://api.example.test/pubsub/gmail';
export const PUSH_SERVICE_ACCOUNT = 'fss-test-push@callie-fss.iam.gserviceaccount.test';

export interface MailWorldMailbox {
  readonly workspace: SeededWorkspace;
  readonly context: RepositoryContext;
  readonly mailboxId: string;
  readonly address: string;
  readonly gmail: RecordedGmailClient;
  readonly fixture: GmailFixture;
  /** The fixture's message list, mutable so a test can add what Gmail receives next. */
  readonly messages: GmailFixtureMessage[];
}

export interface MailWorld {
  readonly database: TestDatabase;
  readonly seeded: TwoWorkspaces;
  readonly crm: SeededCrm;
  readonly config: MailPublicConfig;
  readonly cipher: EnvelopeCipher;
  readonly journal: RecordingSuppressionJournal;
  readonly replyPromoter: ReturnType<typeof recordingReplyPromoter>;
  readonly alpha: MailWorldMailbox;
  readonly beta: MailWorldMailbox;
  /** A repository context for the system actor in one workspace. */
  systemContext(workspaceId: string): RepositoryContext;
  /** A repository context for that workspace's salesperson: what a route would build. */
  userContext(workspaceId: string): RepositoryContext;
  /** A Gmail client over a fixture with one field changed. */
  clientWith(mailbox: MailWorldMailbox, overrides: Partial<GmailFixture>): RecordedGmailClient;
  /** The deps a sync or recovery run takes, for one mailbox's Gmail fixture. */
  syncDeps(mailbox: MailWorldMailbox, overrides?: Partial<MailSyncDeps>): MailSyncDeps;
  stop(): Promise<void>;
}

export function mailConfig(): MailPublicConfig {
  return {
    clientId: 'test-gmail-client.apps.googleusercontent.test',
    redirectUri: 'https://api.example.test/oauth/gmail/callback',
    authorizationEndpoint: 'https://accounts.example.test/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.example.test/token',
    revocationEndpoint: 'https://oauth2.example.test/revoke',
    apiBaseUrl: 'https://gmail.example.test',
    pushTopicName: TEST_TOPIC_NAME,
    pushAudience: PUSH_AUDIENCE,
    pushServiceAccountEmail: PUSH_SERVICE_ACCOUNT,
    hostedDomain: 'example.test',
    baselineDays: 30,
  };
}

/** A fixture message with the allowlisted headers filled in. */
export function fixtureMessage(input: {
  readonly id: string;
  readonly threadId?: string | undefined;
  readonly historyId: string;
  readonly from: string;
  readonly to: string;
  readonly subject?: string | undefined;
  readonly body?: string | undefined;
  readonly bodyTruncated?: boolean | undefined;
  readonly references?: readonly string[] | undefined;
  readonly inReplyTo?: string | undefined;
  readonly messageId?: string | undefined;
  readonly autoSubmitted?: string | undefined;
  readonly listId?: string | undefined;
  readonly internalDateEpochMilliseconds?: number | undefined;
  readonly labelIds?: readonly string[] | undefined;
  readonly attachments?: readonly { readonly filename: string; readonly mimeType: string; readonly sizeBytes: number; readonly attachmentId: string }[] | undefined;
}): GmailFixtureMessage {
  const headers: Record<string, string> = {
    From: input.from,
    To: input.to,
    Subject: input.subject ?? 'Re: hello',
    Date: new Date(input.internalDateEpochMilliseconds ?? Date.parse('2026-09-10T14:00:00Z')).toUTCString(),
    'Message-ID': `<${input.messageId ?? `${input.id}@mail.example.test`}>`,
  };
  if (input.references !== undefined) {
    headers['References'] = input.references.map(reference => `<${reference}>`).join(' ');
  }
  if (input.inReplyTo !== undefined) headers['In-Reply-To'] = `<${input.inReplyTo}>`;
  if (input.autoSubmitted !== undefined) headers['Auto-Submitted'] = input.autoSubmitted;
  if (input.listId !== undefined) headers['List-Id'] = input.listId;
  // A header FSS never asks for. The fake drops it, which is the assertion.
  headers['X-Never-Requested'] = 'a value no allowlist contains';

  return {
    id: input.id,
    threadId: input.threadId ?? `thread-${input.id}`,
    internalDateEpochMilliseconds: input.internalDateEpochMilliseconds ?? Date.parse('2026-09-10T14:00:00Z'),
    labelIds: input.labelIds ?? ['INBOX'],
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.bodyTruncated === undefined ? {} : { bodyTruncated: input.bodyTruncated }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    historyId: input.historyId,
  };
}

export interface MailWorldOptions {
  /** Messages the alpha mailbox's Gmail holds at the start. */
  readonly alphaMessages?: readonly GmailFixtureMessage[] | undefined;
  readonly betaMessages?: readonly GmailFixtureMessage[] | undefined;
  readonly alphaHistoryId?: string | undefined;
  readonly betaHistoryId?: string | undefined;
}

async function connect(
  database: TestDatabase,
  workspace: SeededWorkspace,
  config: MailPublicConfig,
  cipher: EnvelopeCipher,
  stateSigningKey: Buffer,
  secretValue: string,
  fixture: GmailFixture,
  now: Date,
): Promise<MailWorldMailbox> {
  const gmail = recordedGmailClient(fixture);
  const context = repositoryContext(
    workspaceScope(workspace.workspaceId, {
      kind: 'user',
      userId: workspace.salesperson.userId,
      role: 'salesperson',
    }),
    database.session,
  );
  const state = signGrantState(stateSigningKey, {
    workspaceId: workspace.workspaceId,
    userId: workspace.salesperson.userId,
    expiresAtEpochSeconds: Math.floor(now.getTime() / 1000) + 600,
  });
  const outcome = await completeGmailGrant(
    context,
    {
      gmail,
      config,
      secrets: staticSecretProvider({ gmail_oauth_client_secret: secretValue }),
      cipher,
      stateSigningKey,
      now: () => now,
    },
    { state, code: `code-${workspace.slug}` },
  );
  if (!outcome.ok) throw new Error(`the fixture mailbox did not connect: ${outcome.reason}`);
  return {
    workspace,
    context,
    mailboxId: outcome.value.mailboxId,
    address: outcome.value.emailAddress,
    gmail,
    fixture,
    messages: fixture.messages as GmailFixtureMessage[],
  };
}

export async function createMailWorld(options: MailWorldOptions = {}): Promise<MailWorld> {
  const database = await createTestDatabase();
  const seeded = await seedTwoWorkspaces(database.session);
  const crm = await seedCrm(database.session, seeded);
  const config = mailConfig();
  const cipher = localEnvelopeCipher('test-envelope');
  const journal = recordingSuppressionJournal();
  const replyPromoter = recordingReplyPromoter();
  // Generated now. Nothing in this repository is a secret, including in a test.
  const stateSigningKey = randomBytes(32);
  const secretValue = randomBytes(24).toString('base64url');
  const now = new Date('2026-09-11T12:00:00Z');

  const alphaFixture: GmailFixture = {
    emailAddress: `sales.${seeded.alpha.slug}@example.test`,
    historyId: options.alphaHistoryId ?? '1000',
    messages: [...(options.alphaMessages ?? [])],
    refreshToken: randomBytes(24).toString('base64url'),
  };
  const betaFixture: GmailFixture = {
    emailAddress: `sales.${seeded.beta.slug}@example.test`,
    historyId: options.betaHistoryId ?? '1000',
    messages: [...(options.betaMessages ?? [])],
    refreshToken: randomBytes(24).toString('base64url'),
  };

  const alpha = await connect(database, seeded.alpha, config, cipher, stateSigningKey, secretValue, alphaFixture, now);
  const beta = await connect(database, seeded.beta, config, cipher, stateSigningKey, secretValue, betaFixture, now);

  const systemContext = (workspaceId: string): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);

  const userContext = (workspaceId: string): RepositoryContext => {
    const workspace = workspaceId === seeded.alpha.workspaceId ? seeded.alpha : seeded.beta;
    return repositoryContext(
      workspaceScope(workspaceId, {
        kind: 'user',
        userId: workspace.salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );
  };

  const syncDeps = (mailbox: MailWorldMailbox, overrides: Partial<MailSyncDeps> = {}): MailSyncDeps => ({
    gmail: mailbox.gmail,
    oauth: {
      clientId: config.clientId,
      clientSecret: secretValue,
      redirectUri: config.redirectUri,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      revocationEndpoint: config.revocationEndpoint,
      apiBaseUrl: config.apiBaseUrl,
    },
    cipher,
    journal,
    replyPromoter,
    ...overrides,
  });

  return {
    database,
    seeded,
    crm,
    config,
    cipher,
    journal,
    replyPromoter,
    alpha,
    beta,
    systemContext,
    userContext,
    clientWith: (mailbox, overrides) => recordedGmailClient({ ...mailbox.fixture, ...overrides }),
    syncDeps,
    stop: async () => {
      await database.drop();
    },
  };
}

/** A second firm, contact, route and open opportunity in one workspace. */
export async function seedAnotherFirm(
  world: MailWorld,
  workspace: SeededWorkspace,
  input: { readonly name: string; readonly address: string },
): Promise<{ readonly firmId: string; readonly contactId: string; readonly opportunityId: string }> {
  const session = world.database.session;
  const firm = await session.query<{ id: string }>(
    'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
    [workspace.workspaceId, input.name, workspace.salesperson.userId],
  );
  const firmId = firm.rows[0]?.id ?? '';
  const contact = await session.query<{ id: string }>(
    `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Pat Example') RETURNING id`,
    [workspace.workspaceId, firmId],
  );
  const contactId = contact.rows[0]?.id ?? '';
  await session.query(
    `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at,
                                  association_confidence, technical_validation, eligibility, eligibility_policy_version)
     VALUES ($1, $2, $3, $4, 'research_provider', TIMESTAMPTZ '2026-09-01 12:00:00+00',
             0.900, 'passed', 'usable', 'route-policy.1')`,
    [workspace.workspaceId, firmId, contactId, input.address],
  );
  const stageId = await firstStageId(session, workspace.workspaceId);
  const opportunity = await session.query<{ id: string }>(
    `INSERT INTO opportunities (workspace_id, firm_id, stage_id, control_mode_changed_at)
     VALUES ($1, $2, $3, TIMESTAMPTZ '2026-09-01 12:00:00+00') RETURNING id`,
    [workspace.workspaceId, firmId, stageId],
  );
  return { firmId, contactId, opportunityId: opportunity.rows[0]?.id ?? '' };
}
