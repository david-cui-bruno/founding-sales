import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repositoryContext, workspaceScope, type SessionQueryable } from '@fss/domain/db';
import {
  fixturePushTokens,
  localEnvelopeCipher,
  recordedGmailClient,
  signGrantState,
  staticSecretProvider,
  type MailPublicConfig,
} from '@fss/domain/mail';
import { recordAuthenticationChecklist } from '@fss/domain/outbound';
import { dispatch, type ApiOptions, type ApiRequest } from '../src/server.ts';
import { recordingLogger } from '../src/bootstrap/log.ts';
import type { MailRoutingDeps } from '../src/routes/types.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture, type SeededMember } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

/**
 * How a sending domain comes to exist, through the real dispatcher (lane g57).
 *
 * Production on 24 September 2026: the only workspace had its admin signed in and
 * `callie@usecallie.com` connected, the admin had verified SPF, DKIM, DMARC and
 * Postmaster Tools — and Administration read "No sending domain is configured." with
 * no checkbox, because nothing in the tree inserted a `sending_domains` row and the
 * checklist command is an UPDATE that answers `domain_unknown` without one.
 *
 * Two surfaces are proved here. `POST /outbound/domain` is the admin's, and is refused
 * to a salesperson with the same redacted 403 every `/outbound/*` path gives. The Gmail
 * callback is the zero-step one: a connected mailbox's domain becomes the workspace's
 * sending domain, once, and a registration that fails never turns a connected mailbox
 * into a "not connected" page.
 *
 * ## The vacuous-pass trap, named
 *
 * "The callback answered 200" is true of the callback before this lane, so every
 * connect case reads `sending_domains` back — by count, and by the checklist columns
 * a reconnect must not reset. And "no row for gmail.com" is true of a callback that
 * registers nothing at all, so the consumer case runs after the positive one in the
 * same workspace, with the same route, and the positive case is what the mutation in
 * `scripts/releaseMutationCheck.mjs` breaks.
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
    expectedSystemGeneration: null,
    auth: fixture.deps,
    ...overrides,
  };
}

async function post(
  path: string,
  token: string | null,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request: ApiRequest = {
    method: 'POST',
    path,
    query: new URLSearchParams(),
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
  };
  const result = await dispatch(request, baseOptions());
  return { status: result.status, body: result.body as Record<string, unknown> };
}

const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  commandId: randomUUID(),
  clientVersion: CURRENT_CLIENT_VERSION,
  ...extra,
});

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

describe('POST /outbound/domain', () => {
  let adminToken: string;
  let salespersonToken: string;

  beforeAll(async () => {
    adminToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)).accessToken;
  });

  it('is refused without a session, and to a salesperson with the redacted 403 and no row', async () => {
    expect((await post('/outbound/domain', null, command({ domain: 'sending.example.test' }))).status).toBe(401);
    const forbidden = await post('/outbound/domain', salespersonToken, command({ domain: 'sending.example.test' }));
    expect(forbidden.status).toBe(403);
    // The same body every `/outbound/*` refusal gives a salesperson, and nothing in it
    // about what exists on the other side.
    const reference = await post('/outbound/status', salespersonToken, {});
    expect(forbidden.body).toEqual(reference.body);
    expect(JSON.stringify(forbidden.body)).not.toContain('sending.example.test');
    expect(await domainsOf(fixture.beta.workspaceId)).toEqual([]);
  });

  it('registers the domain as primary with the checklist unticked, and Administration can then record it', async () => {
    const before = await post('/outbound/status', adminToken, {});
    // The production state this lane exists for.
    expect(before.body['domain']).toBeNull();

    const registered = await post('/outbound/domain', adminToken, command({ domain: '  Sending.Example.Test ' }));
    expect(registered.status).toBe(200);
    const result = registered.body['result'] as Record<string, unknown>;
    expect(result).toMatchObject({
      domain: 'sending.example.test',
      isPrimary: true,
      outcome: 'created',
      spfPass: false,
      dkimPass: false,
      dmarcPass: false,
      postmasterReviewedAt: null,
      authenticationPasses: false,
      automatedSendingEnabled: false,
    });

    // What the desktop reads: a domain, so the checkboxes render.
    const after = await post('/outbound/status', adminToken, {});
    expect((after.body['domain'] as Record<string, unknown>)['domain']).toBe('sending.example.test');

    // And the checklist the admin could not record before now lands on the row.
    const recorded = await post(
      '/outbound/authentication',
      adminToken,
      command({
        domain: 'sending.example.test',
        spfPass: true,
        dkimPass: true,
        dmarcPass: true,
        postmasterReviewed: true,
        automatedSendingEnabled: false,
      }),
    );
    expect(recorded.status).toBe(200);
    expect((recorded.body['result'] as Record<string, unknown>)['authenticationPasses']).toBe(true);

    // The command went through the receipt, the way every sibling command does.
    const receipts = await fixture.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE workspace_id = $1 AND command_kind = 'register_sending_domain'",
      [fixture.beta.workspaceId],
    );
    expect(receipts.rows[0]?.count).toBe('1');
    expect(await registrationAudits(fixture.beta.workspaceId)).toEqual([
      { domain: 'sending.example.test', isPrimary: true, registeredBy: 'admin' },
    ]);
  });

  it('answers a second registration with the row as it is, never resetting the checklist', async () => {
    const again = await post('/outbound/domain', adminToken, command({ domain: 'sending.example.test' }));
    expect(again.status).toBe(200);
    expect(again.body['result']).toMatchObject({ outcome: 'existing', isPrimary: true, authenticationPasses: true });
    const rows = await domainsOf(fixture.beta.workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ spf_pass: true, dkim_pass: true, dmarc_pass: true });

    // A second domain is registered beside the primary, never instead of it.
    const second = await post('/outbound/domain', adminToken, command({ domain: 'other.example.test' }));
    expect(second.body['result']).toMatchObject({ outcome: 'created', isPrimary: false });
    const status = await post('/outbound/status', adminToken, {});
    expect((status.body['domain'] as Record<string, unknown>)['domain']).toBe('sending.example.test');
  });

  it('refuses an address, a URL and personal Gmail, and writes nothing', async () => {
    const before = await domainsOf(fixture.beta.workspaceId);
    for (const [domain, reason] of [
      ['callie@sending.example.test', 'domain_invalid'],
      ['https://sending.example.test', 'domain_invalid'],
      ['gmail.com', 'personal_gmail_domain'],
      ['GoogleMail.com', 'personal_gmail_domain'],
    ] as const) {
      const refused = await post('/outbound/domain', adminToken, command({ domain }));
      expect(refused.status, domain).toBe(409);
      expect(refused.body['reason'], domain).toBe(reason);
    }
    expect(await domainsOf(fixture.beta.workspaceId)).toEqual(before);
  });
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
