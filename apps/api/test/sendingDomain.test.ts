import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { type MailPublicConfig } from '@fss/domain/mail/config.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { signGrantState } from '@fss/domain/mail/oauth.ts';
import { fixturePushTokens } from '@fss/domain/mail/pushToken.ts';
import { staticSecretProvider } from '@fss/domain/mail/secretProvider.ts';
import { recordAuthenticationChecklist } from '@fss/domain/outbound/domainGuard.ts';
import { dispatch, type ApiOptions } from '../src/server.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import type { MailRoutingDeps } from '../src/routes/types.ts';
import { createAuthFixture, type AuthFixture, type SeededMember } from './support/authFixture.ts';

/**
 * How a sending domain comes to exist, through the real dispatcher (lane g57).
 *
 * Production on 24 September 2026: the only workspace had its admin signed in and
 * `callie@usecallie.com` connected, the admin had verified SPF, DKIM, DMARC and
 * Postmaster Tools — and Administration read "No sending domain is configured." with
 * no checkbox, because nothing in the tree inserted a `sending_domains` row and the
 * checklist command is an UPDATE that answers `domain_unknown` without one.
 *
 * The Gmail callback is the surface proved here (`POST /outbound/domain`, the admin's
 * fallback, had no caller and went in wave 2, S6): a connected mailbox's domain becomes the workspace's
 * sending domain, once, and a registration that fails never turns a connected mailbox
 * into a "not connected" page.
 *
 * ## The vacuous-pass trap, named
 *
 * "The callback answered 200" is true of the callback before this lane, so every
 * connect case reads `sending_domains` back — by count, and by the checklist columns
 * a reconnect must not reset. And "no row for gmail.com" is true of a callback that
 * registers nothing at all, so the consumer case runs after the positive one in the
 * same workspace, with the same route, and the positive case is the one a callback
 * that registers nothing fails.
 */

let fixture: AuthFixture;
const stateSigningKey = randomBytes(32);
const pushTokens = fixturePushTokens();

const mailConfig = (hostedDomain: string): MailPublicConfig => ({
  clientId: 'sending-domain-test.apps.googleusercontent.test',
  redirectUri: 'https://api.example.test/oauth/gmail/callback',
  authorizationEndpoint: 'https://accounts.example.test/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.example.test/token',
  revocationEndpoint: 'https://oauth2.example.test/revoke',
  apiBaseUrl: 'https://gmail.example.test',
  pushTopicName: 'projects/callie-fss/topics/fss-test-gmail-push',
  pushAudience: 'https://api.example.test/integrations/gmail/push',
  pushServiceAccountEmail: 'fss-test-push@callie-fss.iam.gserviceaccount.test',
  hostedDomain,
  baselineDays: 30,
});

/** Mail deps whose recorded Google answers with `emailAddress` for any code. */
function mailFor(emailAddress: string, hostedDomain: string): MailRoutingDeps {
  return {
    gmail: recordedGmailClient({
      emailAddress,
      historyId: '1000',
      messages: [],
      refreshToken: randomBytes(24).toString('base64url'),
    }),
    config: mailConfig(hostedDomain),
    secrets: staticSecretProvider({ gmail_oauth_client_secret: randomBytes(24).toString('base64url') }),
    cipher: localEnvelopeCipher('sending-domain-test-envelope'),
    stateSigningKey,
    pushVerifier: pushTokens.verifier,
  };
}

function baseOptions(overrides: Partial<ApiOptions> = {}): ApiOptions {
  return {
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    ...overrides,
  };
}

/** Complete a Gmail grant for `member` of `workspaceId`, the way Google's redirect does. */
async function callback(
  workspaceId: string,
  member: SeededMember,
  options: ApiOptions,
): Promise<{ status: number; body: string }> {
  const state = signGrantState(stateSigningKey, {
    workspaceId,
    userId: member.userId,
    expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 600,
  });
  const result = await dispatch(
    {
      method: 'GET',
      path: '/oauth/gmail/callback',
      query: new URLSearchParams({ state, code: `code-${randomUUID()}` }),
      headers: {},
      body: undefined,
    },
    options,
  );
  return { status: result.status, body: String(result.body) };
}

interface DomainRow {
  id: string;
  domain: string;
  is_primary: boolean;
  spf_pass: boolean;
  dkim_pass: boolean;
  dmarc_pass: boolean;
  postmaster_reviewed_at: Date | null;
  [column: string]: unknown;
}

async function domainsOf(workspaceId: string): Promise<DomainRow[]> {
  const { rows } = await fixture.db.query<DomainRow>(
    `SELECT id, domain, is_primary, spf_pass, dkim_pass, dmarc_pass, postmaster_reviewed_at
       FROM sending_domains WHERE workspace_id = $1 ORDER BY created_at, domain`,
    [workspaceId],
  );
  return rows;
}

async function registrationAudits(workspaceId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await fixture.db.query<{ detail: Record<string, unknown> }>(
    "SELECT detail FROM audit_events WHERE workspace_id = $1 AND action = 'sending_domain.registered' ORDER BY occurred_at",
    [workspaceId],
  );
  return rows.map(row => row.detail);
}

beforeAll(async () => {
  fixture = await createAuthFixture();
});

afterAll(async () => {
  await fixture.stop();
});

describe('the Gmail callback registers the connected mailbox’s domain', () => {
  const address = (): string => `sales.alpha@${fixture.hostedDomain}`;

  it('still connects the mailbox when the registration fails, and says so in a warn line', async () => {
    // A session that refuses exactly the one statement this lane added, and forwards
    // every other statement to the real database — so the grant, the token, the hold
    // and the audit row are all written, and only the registration throws.
    const failing = {
      query: async (text: string, values?: readonly unknown[]) => {
        if (text.includes('INSERT INTO sending_domains')) throw new Error('sending_domains is unavailable here');
        return await fixture.db.query(text, values);
      },
    } as unknown as SessionQueryable;
    const log = recordingLogger();

    const page = await callback(
      fixture.alpha.workspaceId,
      fixture.alpha.salesperson,
      baseOptions({
        session: failing,
        auth: { ...fixture.deps, db: failing },
        mail: mailFor(address(), fixture.hostedDomain),
        log,
      }),
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain('Gmail connected');

    const mailbox = await fixture.db.query<{ status: string }>(
      'SELECT status FROM mailboxes WHERE workspace_id = $1 AND email_address = $2',
      [fixture.alpha.workspaceId, address()],
    );
    expect(mailbox.rows[0]?.status).toBe('connected');
    expect(await domainsOf(fixture.alpha.workspaceId)).toEqual([]);
    expect(log.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', event: 'sending_domain_registration_failed' }),
    );
  });

  it('registers the domain once, as primary, and a reconnect leaves the recorded checklist alone', async () => {
    const log = recordingLogger();
    const options = baseOptions({ mail: mailFor(address(), fixture.hostedDomain), log });

    const first = await callback(fixture.alpha.workspaceId, fixture.alpha.salesperson, options);
    expect(first.status).toBe(200);
    const created = await domainsOf(fixture.alpha.workspaceId);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      domain: fixture.hostedDomain,
      is_primary: true,
      spf_pass: false,
      dkim_pass: false,
      dmarc_pass: false,
      postmaster_reviewed_at: null,
    });
    expect(await registrationAudits(fixture.alpha.workspaceId)).toEqual([
      { domain: fixture.hostedDomain, isPrimary: true, registeredBy: 'mailbox_connect' },
    ]);
    expect(log.lines).toContainEqual(
      expect.objectContaining({ level: 'info', event: 'sending_domain_registered', domain: fixture.hostedDomain }),
    );

    // The admin records the checklist against the row the connect created.
    const admin = repositoryContext(
      workspaceScope(fixture.alpha.workspaceId, { kind: 'user', userId: fixture.alpha.admin.userId, role: 'admin' }),
      fixture.db,
    );
    const recorded = await recordAuthenticationChecklist(admin, {
      domain: fixture.hostedDomain,
      adminUserId: fixture.alpha.admin.userId,
      spfPass: true,
      dkimPass: true,
      dmarcPass: true,
      postmasterReviewed: true,
    });
    expect(recorded.ok).toBe(true);

    // A reconnect is a read: the same row, nothing reset, no second audit.
    const second = await callback(fixture.alpha.workspaceId, fixture.alpha.salesperson, options);
    expect(second.status).toBe(200);
    const kept = await domainsOf(fixture.alpha.workspaceId);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe(created[0]?.id);
    expect(kept[0]).toMatchObject({ is_primary: true, spf_pass: true, dkim_pass: true, dmarc_pass: true });
    expect(kept[0]?.postmaster_reviewed_at).not.toBeNull();
    expect(await registrationAudits(fixture.alpha.workspaceId)).toHaveLength(1);
  });

  it('never registers personal Gmail, and still connects the mailbox', async () => {
    // Only reachable where the deployment's hosted domain is gmail.com, because
    // `completeGmailGrant` refuses any other domain first; the refusal is still the
    // registration's own, so a deployment that relaxed the hosted-domain check could
    // not turn a personal inbox into a sending domain.
    const log = recordingLogger();
    const personal = 'admin.alpha@gmail.com';
    const page = await callback(
      fixture.alpha.workspaceId,
      fixture.alpha.admin,
      baseOptions({ mail: mailFor(personal, 'gmail.com'), log }),
    );
    expect(page.status).toBe(200);
    expect(page.body).toContain('Gmail connected');

    const rows = await domainsOf(fixture.alpha.workspaceId);
    expect(rows.map(row => row.domain)).toEqual([fixture.hostedDomain]);
    expect(log.lines).toContainEqual(
      expect.objectContaining({ level: 'info', event: 'sending_domain_not_registered', reason: 'personal_gmail_domain' }),
    );
  });
});
