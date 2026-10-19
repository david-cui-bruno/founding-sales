import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gmailStatusSchema } from '@fss/contracts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { localEnvelopeCipher } from '@fss/domain/mail/envelope.ts';
import { verifyExistingGmailGrant } from '@fss/domain/mail/existingGrant.ts';
import { createGmailHttpClient, type HttpFetch, type HttpResponse } from '@fss/domain/mail/gmailClientHttp.ts';
import { fixturePushTokens } from '@fss/domain/mail/pushToken.ts';
import { staticSecretProvider } from '@fss/domain/mail/secretProvider.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';
import { GMAIL_SCOPES } from '@fss/domain/mail/types.ts';
import type { MailRoutingDeps } from '../src/routes/types.ts';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';

const TOKEN = 'https://oauth2.googleapis.com/token';
const PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });

// Registered API route, real app_runtime privileges and disposable PostgreSQL.
// Only the Google HTTP transport and local envelope cipher are controlled doubles.
describe('ordinary existing Gmail grant verification', () => {
  let fixture: AuthFixture;
  let db: SessionQueryable;
  let other: SessionQueryable;
  let mail: MailRoutingDeps;
  let mailboxId: string;
  let generation: number;
  let token: string;
  let deviceId: string;
  let profileAddress: string;
  let scope: unknown;
  let tokenStatus: number;
  let profileStatus: number;
  let tokenThrows: boolean;
  let onProfile: (() => Promise<void>) | undefined;
  let onToken: (() => Promise<void>) | undefined;
  const requests: string[] = [];
  const transactions: (string | null)[] = [];
  const access = randomBytes(24).toString('base64url');
  const refresh = randomBytes(24).toString('base64url');

  const fetch: HttpFetch = async (url, request) => {
    requests.push(url);
    transactions.push((await db.query<{ txid: string | null }>('SELECT txid_current_if_assigned()::text AS txid')).rows[0]!.txid);
    if (url === TOKEN) {
      expect(request?.method).toBe('POST');
      expect(new URLSearchParams(request?.body).get('grant_type')).toBe('refresh_token');
      await onToken?.();
      if (tokenThrows) throw new Error('controlled provider transport failure');
      return tokenStatus === 200
        ? json(200, { access_token: access, expires_in: 3600, scope })
        : json(tokenStatus, { error: 'invalid_grant' });
    }
    if (url === PROFILE) {
      await onProfile?.();
      return json(profileStatus, { emailAddress: profileAddress, historyId: '123' });
    }
    throw new Error('Unexpected provider endpoint, no message reads permitted');
  };

  const context = (session = db) => repositoryContext(workspaceScope(fixture.alpha.workspaceId,
    { kind: 'user', userId: fixture.alpha.salesperson.userId, role: 'salesperson' }), session);
  const status = (session = db, bearer: string | null = token) => dispatch({
    method: 'GET', path: '/gmail/status', query: new URLSearchParams(), body: undefined,
    headers: bearer === null ? {} : { authorization: `Bearer ${bearer}` },
  }, {
    session, auth: { ...fixture.deps, db: session }, mail, sendingEnabled: false,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
  });
  const observations = async () => (await fixture.db.query<{ granted_scopes: string[] }>(
    'SELECT granted_scopes FROM mailbox_oauth_grant_observations WHERE workspace_id=$1 AND mailbox_id=$2 AND generation=$3',
    [fixture.alpha.workspaceId, mailboxId, generation],
  )).rows;
  const unchangedAuthority = async () => {
    for (const table of ['crm_capability_owner_approvals', 'crm_mail_capture_controls', 'crm_business_policies']) {
      expect((await fixture.db.query(`SELECT 1 FROM ${table}`)).rows).toEqual([]);
    }
    for (const table of ['mailbox_watches', 'crm_mail_sources', 'mail_message_bodies']) {
      expect((await fixture.db.query(`SELECT 1 FROM ${table}`)).rows).toEqual([]);
    }
  };
  const mutateMailbox = async (set: string, values: readonly unknown[] = []) => {
    await fixture.db.query(`UPDATE mailboxes SET ${set} WHERE workspace_id=$1 AND id=$2`,
      [fixture.alpha.workspaceId, mailboxId, ...values]);
  };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    db = await fixture.database.appRuntimeSession();
    other = await fixture.database.appRuntimeSession();
    mailboxId = (await fixture.db.query<{ id: string }>(
      'INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,generation) VALUES($1,$2,$3,$3,1) RETURNING id',
      [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId, fixture.alpha.salesperson.email],
    )).rows[0]!.id;
    mail = {
      gmail: createGmailHttpClient({ fetch, apiBaseUrl: 'https://gmail.googleapis.com' }),
      cipher: localEnvelopeCipher('existing-grant-test'),
      secrets: staticSecretProvider({ gmail_oauth_client_secret: randomBytes(24).toString('base64url') }),
      stateSigningKey: randomBytes(32), pushVerifier: fixturePushTokens().verifier,
      config: {
        clientId: 'existing-grant.apps.googleusercontent.test', redirectUri: 'https://api.example.test/oauth/gmail/callback',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: TOKEN,
        revocationEndpoint: 'https://oauth2.googleapis.com/revoke', apiBaseUrl: 'https://gmail.googleapis.com',
        pushTopicName: 'projects/test/topics/test', pushAudience: 'https://api.example.test/integrations/gmail/push',
        pushServiceAccountEmail: 'test@example.test', hostedDomain: fixture.hostedDomain, baselineDays: 30,
      },
    };
  });
  beforeEach(async () => {
    await fixture.db.query("UPDATE workspace_memberships SET status='active',deactivated_at=NULL,role='salesperson' WHERE workspace_id=$1 AND user_id=$2",
      [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
    const grant = await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson);
    token = grant.accessToken;
    deviceId = grant.deviceId;
    await mutateMailbox("owner_user_id=$3,email_address=$4,provider_account_id=$4,status='connected',generation=generation+1,disconnected_at=NULL,disconnect_reason=NULL",
      [fixture.alpha.salesperson.userId, fixture.alpha.salesperson.email]);
    generation = (await fixture.db.query<{ generation: number }>('SELECT generation FROM mailboxes WHERE workspace_id=$1 AND id=$2',
      [fixture.alpha.workspaceId, mailboxId])).rows[0]!.generation;
    await storeRefreshToken(context(), { mailboxId, plaintext: refresh, cipher: mail.cipher });
    profileAddress = fixture.alpha.salesperson.email;
    scope = GMAIL_SCOPES.join(' ');
    tokenStatus = 200;
    profileStatus = 200;
    tokenThrows = false;
    onProfile = undefined;
    onToken = undefined;
    requests.length = 0;
    transactions.length = 0;
  });
  afterAll(async () => fixture.stop());

  it('repairs legacy generation 2 without reconnect, capture, owner approvals or mail reads', async () => {
    expect(generation).toBe(2);
    const result = await status();
    expect(result.status).toBe(200);
    expect(gmailStatusSchema.parse(result.body)).toMatchObject({ connected: true, mailbox: { id: mailboxId } });
    expect(await observations()).toEqual([{ granted_scopes: [...GMAIL_SCOPES].sort() }]);
    expect(requests).toEqual([TOKEN, PROFILE]);
    expect(transactions).toEqual([null, null]);
    expect(JSON.stringify(result.body)).not.toContain(access);
    expect(JSON.stringify(result.body)).not.toContain(refresh);
    await unchangedAuthority();
    expect((await status()).status).toBe(200);
    expect(requests).toEqual([TOKEN, PROFILE]);
    expect(await observations()).toHaveLength(1);
  });

  it.each([undefined, '', GMAIL_SCOPES[0], GMAIL_SCOPES[1], 42])('does not invent missing/incomplete scope evidence: %s', async evidence => {
    scope = evidence;
    expect((await status()).status).toBe(200);
    expect(await observations()).toEqual([]);
    expect(requests).toEqual([TOKEN]);
    await unchangedAuthority();
  });

  it('records actual returned scopes, deduplicated, not the requested scope list', async () => {
    const extra = 'https://www.googleapis.com/auth/userinfo.email';
    scope = ` ${GMAIL_SCOPES.join('\t')} ${extra} ${GMAIL_SCOPES[0]} `;
    expect((await status()).status).toBe(200);
    expect(await observations()).toEqual([{ granted_scopes: [...GMAIL_SCOPES, extra].sort() }]);
    await unchangedAuthority();
  });

  it('refuses the wrong Google account even with complete scopes', async () => {
    profileAddress = `other@${fixture.hostedDomain}`;
    expect((await status()).status).toBe(200);
    expect(await observations()).toEqual([]);
  });

  it.each(['revoked', 'rate_limited', 'transport', 'profile_refused'] as const)('fails closed on provider %s without leaking errors', async failure => {
    tokenStatus = failure === 'revoked' ? 400 : failure === 'rate_limited' ? 429 : 200;
    tokenThrows = failure === 'transport';
    profileStatus = failure === 'profile_refused' ? 401 : 200;
    const result = await status();
    expect(result.status).toBe(200);
    expect(await observations()).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain('controlled provider transport failure');
    await unchangedAuthority();
  });

  it('does not call Google without a stored token', async () => {
    await fixture.db.query('DELETE FROM mailbox_tokens WHERE workspace_id=$1 AND mailbox_id=$2', [fixture.alpha.workspaceId, mailboxId]);
    expect((await status()).status).toBe(200);
    expect(requests).toEqual([]);
    expect(await observations()).toEqual([]);
  });

  it.each(['generation', 'revocation', 'account', 'owner', 'token_replaced', 'token_deleted', 'membership', 'device', 'session'] as const)(
    'rejects %s changed while provider profile is waiting, with no transactional provider locks', async change => {
      let mutated = false;
      onProfile = async () => {
        // A separate backend can mutate immediately during the provider wait.
        await fixture.db.query("SET lock_timeout='1s'");
        if (change === 'generation') await mutateMailbox('generation=generation+1');
        if (change === 'revocation') await mutateMailbox("status='revoked',disconnected_at=clock_timestamp()");
        if (change === 'account') await mutateMailbox("email_address=$3,provider_account_id=$3", [`changed@${fixture.hostedDomain}`]);
        if (change === 'owner') await mutateMailbox('owner_user_id=$3', [fixture.alpha.admin.userId]);
        if (change === 'token_replaced') await storeRefreshToken(context(fixture.db), { mailboxId, plaintext: refresh, cipher: mail.cipher });
        if (change === 'token_deleted') await fixture.db.query('DELETE FROM mailbox_tokens WHERE workspace_id=$1 AND mailbox_id=$2', [fixture.alpha.workspaceId, mailboxId]);
        if (change === 'membership') await fixture.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2", [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId]);
        if (change === 'device') await fixture.db.query("UPDATE devices SET status='revoked',revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2", [fixture.alpha.workspaceId, deviceId]);
        if (change === 'session') await fixture.db.query("UPDATE sessions SET status='ended',ended_at=clock_timestamp(),end_reason='signed_out' WHERE workspace_id=$1 AND device_id=$2", [fixture.alpha.workspaceId, deviceId]);
        mutated = true;
      };
      const result = await status();
      expect(mutated).toBe(true);
      expect(result.status).toBe(['membership', 'device', 'session'].includes(change) ? 401 : 200);
      expect(await observations()).toEqual([]);
      expect(transactions).toEqual([null, null]);
      await unchangedAuthority();
    },
  );

  it('rejects token replacement during refresh, not just during profile', async () => {
    let replaced = false;
    onToken = async () => { await storeRefreshToken(context(fixture.db), { mailboxId, plaintext: refresh, cipher: mail.cipher }); replaced = true; };
    expect((await status()).status).toBe(200);
    expect(replaced).toBe(true);
    expect(await observations()).toEqual([]);
  });

  it('serializes duplicate repairs from two real sessions and records exactly one observation', async () => {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    onProfile = async () => { if (++arrived === 2) release(); await both; };
    const results = await Promise.all([status(), status(other)]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(await observations()).toHaveLength(1);
    await unchangedAuthority();
  });

  it('refuses unauthenticated routes and system impersonation before provider access', async () => {
    expect((await status(db, null)).status).toBe(401);
    const system = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), db);
    expect(await verifyExistingGmailGrant(system, mail, { mailboxId, authorizeObservation: async () => true })).toBe('unavailable');
    const wrongWorkspace = repositoryContext(workspaceScope(fixture.beta.workspaceId,
      { kind: 'user', userId: fixture.beta.salesperson.userId, role: 'salesperson' }), db);
    expect(await verifyExistingGmailGrant(wrongWorkspace, mail, { mailboxId, authorizeObservation: async () => true })).toBe('unavailable');
    expect(requests).toEqual([]);
    expect(await observations()).toEqual([]);
  });
});
