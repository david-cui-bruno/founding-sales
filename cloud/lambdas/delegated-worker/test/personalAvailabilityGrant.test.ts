import { describe, expect, it } from 'vitest';
import { RemoteGoogleAuthorization, type GoogleAccessEvidence } from '../src/remoteGoogleAuthorization';
import { googleGrantSchema, googleScopes, requireCapabilities, type GoogleCapability, type GoogleGrantBeginOptions, type GoogleGrantPurpose } from '../src/googleGrantCapabilities';
import { WorkerAuth, pairingKey, secretHash } from '../src/workerAuth';
import { ConditionalCommandHarness } from './sdkHarness';

const personal = 'personal_availability' as const;
const legacy = 'permitted_correspondence' as const;
const availabilityCalendars = { calendarIds: ['private@example.test'], confirmed: true as const };
const calendars = { ownedCalendarId: 'work@example.test', conflictCalendarIds: ['work@example.test'], confirmed: true as const };
const options = { purpose: personal, availabilityCalendars };
const key = (pairingId: string, purpose: GoogleGrantPurpose = legacy) => `GOOGLE_GRANT#${pairingId}${purpose === personal ? '#personal_availability' : ''}`;
function fixture() {
  const dynamo = new ConditionalCommandHarness();
  let now = Date.parse('2026-09-08T00:00:00.000Z');
  const storeOptions = { dynamo, tableName: 'fictional-worker', workspaceId: 'fictional-workspace', clock: { now: () => new Date(now).toISOString() } };
  const auth = new WorkerAuth(storeOptions);
  const config = { clientId: 'fictional.apps.googleusercontent.com', clientSecret: 'fictional-secret', redirectUri: 'https://worker.example.test/oauth/callback', encryptionKey: Buffer.alloc(32, 7) };
  const calls: { url: string; init?: RequestInit }[] = [];
  let subject = 'work-A'; let email = 'work@example.test';
  let scopes = `openid email ${googleScopes.send} ${googleScopes.relevant_read}`;
  let refreshToken: string | undefined = 'fictional-refresh-A';
  let revoke: 'success' | 'failure' | 'ambiguous' = 'success';
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/token')) return Response.json({ access_token: `fictional-access-${subject}`, ...(refreshToken ? { refresh_token: refreshToken } : {}), token_type: 'Bearer', expires_in: 3600, scope: scopes });
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: subject, email, email_verified: true });
    if (String(url).endsWith('/revoke')) {
      if (revoke === 'ambiguous') throw new Error('fictional-provider-secret');
      return new Response('', { status: revoke === 'success' ? 200 : 503 });
    }
    throw new Error('unconfigured fictional boundary');
  };
  const remote = (injected: typeof globalThis.fetch = fetch) => new RemoteGoogleAuthorization({ auth, config, fetch: injected });
  return { auth, dynamo, config, storeOptions, calls, fetch, remote,
    expire: () => { now += 7200000; }, advance: () => { now += 600001; },
    account: (purpose: GoogleGrantPurpose, nextSubject?: string) => { subject = nextSubject ?? (purpose === personal ? 'personal-B' : 'work-A'); email = purpose === personal ? 'private@example.test' : 'work@example.test'; scopes = `openid email ${purpose === personal ? googleScopes.availability : `${googleScopes.send} ${googleScopes.relevant_read}`}`; refreshToken = `fictional-refresh-${subject}`; },
    scope: (value: string) => { scopes = value; }, refresh: (value?: string) => { refreshToken = value; }, revocation: (value: typeof revoke) => { revoke = value; } };
}
type Fixture = ReturnType<typeof fixture>;
async function paired(f: Fixture) {
  const { code } = await f.auth.issuePairing({ scopes: ['google:grant'], expiresInSeconds: 300 });
  return (await f.auth.redeemPairing(code, 'fictional-source')).pairingId;
}
async function begun(f: Fixture, pairingId: string, purpose: GoogleGrantPurpose = legacy) {
  return new URL((await f.remote().beginGoogleGrant(pairingId, purpose === personal ? ['availability'] : ['send', 'relevant_read'], undefined, purpose === personal ? options : {})).authorizationUrl);
}
async function install(f: Fixture, pairingId: string, purpose: GoogleGrantPurpose = legacy) {
  f.account(purpose);
  const url = await begun(f, pairingId, purpose);
  return f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code');
}
async function row(f: Fixture, pairingId: string, purpose: GoogleGrantPurpose = legacy) { return f.auth.store.get<Record<string, unknown>>(key(pairingId, purpose)); }
async function mutate(f: Fixture, storageKey: string, change: (data: Record<string, unknown>) => Record<string, unknown>) {
  const stored = (await f.auth.store.get<Record<string, unknown>>(storageKey))!;
  await f.auth.store.transact([f.auth.store.put(storageKey, change(stored.data), stored.rev)]);
}
const access = (f: Fixture, pairingId: string, purpose: GoogleGrantPurpose = personal) => f.remote().authorizedAccess(pairingId, purpose === personal ? ['availability'] : ['send'], undefined, purpose);

describe('bounded personal availability grant foundation (offline injected boundaries)', () => {
  it('two accounts coexist, request only selected scopes, and personal operations leave the complete original row and revision unchanged', async () => {
    const f = fixture(); const id = await paired(f); const work = await install(f, id); const original = await row(f, id);
    expect(await f.remote().status(id, personal)).toEqual({ state: 'unconfigured', grant: null });
    await expect(access(f, id)).rejects.toThrow('google_grant_unavailable');
    f.account(personal); const url = await begun(f, id, personal);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['openid', 'email', googleScopes.availability]);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    const status = await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code');
    expect(status).toMatchObject({ state: 'ready', grant: { purpose: personal, subject: 'personal-B', availabilityCalendars, owner: 'remote' } });
    expect(await f.remote().status(id)).toEqual(work);
    expect(await f.remote().status(id, personal)).toEqual(status);
    expect(await row(f, id)).toEqual(original);
    f.expire(); f.refresh();
    const refreshed = await access(f, id);
    expect(refreshed.grant).toEqual(status.grant);
    expect(refreshed.accessEvidence).toMatchObject({ version: 2, purpose: personal, grantRevision: 2 });
    expect(await f.remote().revokeGoogleGrant(id, personal)).toMatchObject({ state: 'revoked', providerRevocation: 'confirmed' });
    expect(new URLSearchParams(String(f.calls.at(-1)?.init?.body)).get('token')).toBe('fictional-refresh-personal-B');
    expect(await row(f, id)).toEqual(original);
    expect(JSON.stringify(status)).not.toMatch(/fictional-(access|refresh)|accessEvidence|verifier/);
    const serialized = JSON.stringify(f.dynamo.transactions);
    expect(serialized).not.toContain('fictional-refresh-personal-B');
    expect(serialized).not.toContain(url.searchParams.get('state')!);
    expect(f.dynamo.inspect('EVENT_HEAD')).toBeUndefined();
  });

  it('legacy default revoke does not revoke personal and absent purpose never falls back to another slot', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal); const before = await row(f, id, personal);
    expect(await f.remote().status(id)).toEqual({ state: 'unconfigured', grant: null });
    await expect(access(f, id, legacy)).rejects.toThrow('google_grant_unavailable');
    await f.remote().revokeGoogleGrant(id);
    expect(await row(f, id, personal)).toEqual(before);
    expect((await access(f, id)).grant.subject).toBe('personal-B');
  });

  it.each<GoogleCapability>(['send', 'relevant_read', 'event_write'])('denies personal %s requests and access without provider calls', async capability => {
    const f = fixture(); const id = await paired(f);
    await expect(f.remote().beginGoogleGrant(id, [capability], undefined, options)).rejects.toThrow('grant_missing_capability');
    await expect(f.remote().beginGoogleGrant(id, ['availability', capability], undefined, options)).rejects.toThrow('grant_missing_capability');
    await install(f, id, personal); const count = f.calls.length;
    await expect(f.remote().authorizedAccess(id, [capability], undefined, personal)).rejects.toThrow('grant_missing_capability');
    expect(f.calls).toHaveLength(count);
    const grant = (await f.remote().status(id, personal)).grant!;
    expect(() => requireCapabilities(grant, [capability])).toThrow('grant_missing_capability');
  });

  it.each([['primary'], ['Private@example.test'], ['private@example.test', 'private@example.test'], [], Array.from({ length: 21 }, (_, i) => `calendar${i}@example.test`)].map(calendarIds => ({ calendarIds })))('rejects nonexplicit, duplicate, missing or unbounded calendar IDs %j', async ({ calendarIds }) => {
    const f = fixture(); const id = await paired(f);
    await expect(f.remote().beginGoogleGrant(id, ['availability'], undefined, { purpose: personal, availabilityCalendars: { calendarIds, confirmed: true } })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it('rejects contradictory selections, unconfirmed selection, and arbitrary purpose at every entry point', async () => {
    const f = fixture(); const id = await paired(f);
    await expect(f.remote().beginGoogleGrant(id, ['availability'], calendars, options)).rejects.toThrow();
    for (const invalid of [ { availabilityCalendars }, { purpose: legacy, availabilityCalendars }, { ...options, expectedEmail: 'work@example.test' }, { ...options, availabilityCalendars: { ...availabilityCalendars, confirmed: false } }, { purpose: 'other', availabilityCalendars } ]) {
      await expect(f.remote().beginGoogleGrant(id, ['availability'], undefined, invalid as GoogleGrantBeginOptions)).rejects.toThrow();
    }
    for (const method of [() => f.remote().status(id, 'other' as GoogleGrantPurpose), () => f.remote().revokeGoogleGrant(id, 'other' as GoogleGrantPurpose), () => f.remote().authorizedAccess(id, ['availability'], undefined, 'other' as GoogleGrantPurpose)]) await expect(method()).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it.each([googleScopes.send, googleScopes.relevant_read, googleScopes.event_write, 'https://www.googleapis.com/auth/userinfo.profile'])('rejects personal returned extra scope %s at initial exchange and refresh', async extra => {
    const f = fixture(); const id = await paired(f); f.account(personal); const url = await begun(f, id, personal);
    f.scope(`openid email ${googleScopes.availability} ${extra}`);
    await expect(f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code')).rejects.toThrow('google_scope_unapproved');
    expect(await row(f, id, personal)).toBeNull();
    await install(f, id, personal); const before = await row(f, id, personal); f.expire(); f.scope(`openid email ${googleScopes.availability} ${extra}`);
    await expect(access(f, id)).rejects.toThrow('google_scope_unapproved');
    expect(await row(f, id, personal)).toEqual(before);
  });

  it('rejects missing required personal scope and malformed loaded personal metadata', async () => {
    const f = fixture(); const id = await paired(f); f.account(personal); const url = await begun(f, id, personal); f.scope('openid email');
    await expect(f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code')).rejects.toThrow('grant_missing_capability');
    const status = await install(f, id, personal); const grant = status.grant!;
    for (const invalid of [{ ...grant, owner: 'local' }, { ...grant, calendars }, { ...grant, capabilities: ['availability', 'send'], grantedScopes: [...grant.grantedScopes, googleScopes.send] }, { ...grant, availabilityCalendars: { calendarIds: ['primary'], confirmed: true } }]) expect(googleGrantSchema.safeParse(invalid).success).toBe(false);
    await mutate(f, key(id, personal), data => ({ ...data, grant: { ...grant, owner: 'local' } }));
    const count = f.calls.length; await expect(access(f, id)).rejects.toThrow(); expect(f.calls).toHaveLength(count);
  });

  it.each([legacy, personal])('pins %s subject at reauthorization, refresh, and after confirmed revoke', async purpose => {
    const f = fixture(); const id = await paired(f); await install(f, id, purpose); const before = await row(f, id, purpose);
    f.account(purpose, 'different-C'); const url = await begun(f, id, purpose);
    await expect(f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code')).rejects.toThrow('oauth_subject_mismatch');
    expect(await row(f, id, purpose)).toEqual(before);
    f.expire(); await expect(access(f, id, purpose)).rejects.toThrow('oauth_subject_mismatch');
    expect(await row(f, id, purpose)).toEqual(before);
    await f.remote().revokeGoogleGrant(id, purpose); const revoked = await row(f, id, purpose); const next = await begun(f, id, purpose);
    await expect(f.remote().completeGoogleGrant(next.searchParams.get('state')!, 'fictional-code')).rejects.toThrow('oauth_subject_mismatch');
    expect(await row(f, id, purpose)).toEqual(revoked);
  });

  it('binds optional explicitly selected work email server-side and preserves missing-field legacy begin', async () => {
    const f = fixture(); const id = await paired(f);
    const mismatch = await f.remote().beginGoogleGrant(id, ['send', 'relevant_read'], undefined, { expectedEmail: 'chosen@example.test' });
    await expect(f.remote().completeGoogleGrant(new URL(mismatch.authorizationUrl).searchParams.get('state')!, 'fictional-code')).rejects.toThrow('oauth_email_mismatch');
    expect(await row(f, id)).toBeNull();
    const match = await f.remote().beginGoogleGrant(id, ['send', 'relevant_read'], undefined, { expectedEmail: 'work@example.test' });
    expect((await f.remote().completeGoogleGrant(new URL(match.authorizationUrl).searchParams.get('state')!, 'fictional-code')).state).toBe('ready');
  });

  it('preserves mixed-capability legacy rows, selection, downgrade check, refresh and v1 evidence', async () => {
    const f = fixture(); const id = await paired(f); const capabilities: GoogleCapability[] = ['send', 'relevant_read', 'availability', 'event_write'];
    const url = new URL((await f.remote().beginGoogleGrant(id, capabilities, calendars)).authorizationUrl);
    f.scope(`openid email ${capabilities.map(c => googleScopes[c]).join(' ')}`);
    const status = await f.remote().completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code');
    const before = await row(f, id);
    await expect(begun(f, id)).rejects.toThrow('grant_missing_capability');
    expect(await row(f, id)).toEqual(before);
    f.expire(); const result = await f.remote().authorizedAccess(id, capabilities);
    expect(result.grant).toEqual(status.grant);
    expect(result.accessEvidence.version).toBe(1); expect(result.accessEvidence).not.toHaveProperty('purpose');
    expect(result.accessEvidence.grantRevision).toBe(2);
    await f.auth.store.transact(f.remote().accessChecks(result.accessEvidence, { pairingId: id, subject: 'work-A', requiredCapabilities: capabilities }));
  });

  it('accepts old missing-purpose state using original context and consumes cancellation once', async () => {
    const f = fixture(); const id = await paired(f); const url = await begun(f, id); const state = url.searchParams.get('state')!;
    const stored = await f.auth.store.get<Record<string, unknown>>(`OAUTH_STATE#${secretHash(state)}`);
    expect(stored?.data).not.toHaveProperty('purpose');
    await f.remote().completeGoogleGrant(state, 'fictional-code');
    const before = await row(f, id); const cancelled = (await begun(f, id)).searchParams.get('state')!;
    await expect(f.remote().completeGoogleGrant(cancelled, null)).rejects.toThrow('oauth_cancelled');
    await expect(f.remote().completeGoogleGrant(cancelled, 'fictional-code')).rejects.toThrow('oauth_state_unavailable');
    expect(await row(f, id)).toEqual(before);
  });

  it('purpose and state-key tampering cannot decrypt a personal verifier even with a legacy-valid rewritten shape', async () => {
    const f = fixture(); const id = await paired(f); f.account(personal); const url = await begun(f, id, personal); const state = url.searchParams.get('state')!;
    await mutate(f, `OAUTH_STATE#${secretHash(state)}`, data => { const rest = { ...data }; delete rest.purpose; delete rest.availabilityCalendars; return { ...rest, calendars }; });
    await expect(f.remote().completeGoogleGrant(state, 'fictional-code')).rejects.toThrow('google_secret_unavailable');
    const other = (await begun(f, id, personal)).searchParams.get('state')!; const replacement = (await begun(f, id, personal)).searchParams.get('state')!;
    const source = (await f.auth.store.get<Record<string, unknown>>(`OAUTH_STATE#${secretHash(other)}`))!;
    await mutate(f, `OAUTH_STATE#${secretHash(replacement)}`, () => source.data);
    await expect(f.remote().completeGoogleGrant(replacement, 'fictional-code')).rejects.toThrow('google_secret_unavailable');
    expect(f.calls).toHaveLength(0);
  });

  it('racing personal callbacks exchange once and simultaneous work/personal begins use separate grant fences', async () => {
    const f = fixture(); const id = await paired(f); const work = await begun(f, id); const personalUrl = await begun(f, id, personal);
    await f.remote().completeGoogleGrant(work.searchParams.get('state')!, 'fictional-code');
    f.account(personal); const state = personalUrl.searchParams.get('state')!;
    const outcomes = await Promise.allSettled([f.remote().completeGoogleGrant(state, 'one'), f.remote().completeGoogleGrant(state, 'two')]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(f.calls.filter(call => call.url.endsWith('/token'))).toHaveLength(2);
    await expect(f.remote().completeGoogleGrant(state, 'replay')).rejects.toThrow('oauth_state_unavailable');
  });

  it('rejects cross-purpose metadata, ciphertext, pairing/workspace and encryption-key transplants before provider use', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id); await install(f, id, personal);
    const work = (await row(f, id))!; const privateRow = (await row(f, id, personal))!; const count = f.calls.length;
    await mutate(f, key(id), () => privateRow.data);
    await expect(f.remote().status(id)).rejects.toThrow('google_grant_purpose_mismatch');
    await expect(access(f, id, legacy)).rejects.toThrow('google_grant_purpose_mismatch');
    await mutate(f, key(id), () => work.data);
    await mutate(f, key(id, personal), data => ({ ...data, ciphertext: work.data.ciphertext }));
    await expect(access(f, id)).rejects.toThrow('google_secret_unavailable');
    await mutate(f, key(id, personal), () => privateRow.data);
    const other = await paired(f); await f.auth.store.transact([f.auth.store.put(key(other, personal), privateRow.data, null)]);
    await expect(access(f, other)).rejects.toThrow('google_secret_unavailable');
    const foreignAuth = new WorkerAuth({ ...f.storeOptions, workspaceId: 'foreign-workspace' });
    const pairing = (await f.auth.store.get(pairingKey(id)))!;
    await foreignAuth.store.transact([foreignAuth.store.put(pairingKey(id), pairing.data, null), foreignAuth.store.put(key(id, personal), privateRow.data, null)]);
    const foreign = new RemoteGoogleAuthorization({ auth: foreignAuth, config: f.config, fetch: f.fetch });
    await expect(foreign.authorizedAccess(id, ['availability'], undefined, personal)).rejects.toThrow('google_secret_unavailable');
    const wrongKey = new RemoteGoogleAuthorization({ auth: f.auth, config: { ...f.config, encryptionKey: Buffer.alloc(32, 8) }, fetch: f.fetch });
    await expect(wrongKey.authorizedAccess(id, ['availability'], undefined, personal)).rejects.toThrow('google_secret_unavailable');
    expect(f.calls).toHaveLength(count);
  });

  it.each([legacy, personal])('preserves %s definite failed revoke ciphertext and explicit retry semantics', async purpose => {
    const f = fixture(); const id = await paired(f); await install(f, id, purpose); const before = (await row(f, id, purpose))!;
    f.revocation('failure'); expect(await f.remote().revokeGoogleGrant(id, purpose)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
    expect((await row(f, id, purpose))?.data).toMatchObject({ ciphertext: before.data.ciphertext, revocationInFlight: false });
    await expect(access(f, id, purpose)).rejects.toThrow('google_grant_unavailable');
    await expect(begun(f, id, purpose)).rejects.toThrow('google_revocation_pending');
    f.revocation('success'); await f.remote().revokeGoogleGrant(id, purpose);
    expect((await row(f, id, purpose))?.data).toMatchObject({ ciphertext: null, providerRevocation: 'confirmed' });
  });

  it('ambiguous personal revoke remains owned indefinitely without mutating or blocking work', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id); const work = await row(f, id); await install(f, id, personal);
    const before = (await row(f, id, personal))!; f.revocation('ambiguous');
    expect(await f.remote().revokeGoogleGrant(id, personal)).toMatchObject({ state: 'revoked', providerRevocation: 'pending' });
    const pending = await row(f, id, personal); expect(pending?.data).toMatchObject({ ciphertext: before.data.ciphertext, revocationInFlight: true });
    f.expire(); const count = f.calls.length;
    expect(await f.remote().revokeGoogleGrant(id, personal)).toMatchObject({ providerRevocation: 'pending' });
    expect(f.calls).toHaveLength(count); expect(await row(f, id, personal)).toEqual(pending);
    await expect(begun(f, id, personal)).rejects.toThrow('google_revocation_pending');
    expect(await row(f, id)).toEqual(work);
    f.account(legacy); expect((await access(f, id, legacy)).grant.subject).toBe('work-A');
    expect(await row(f, id, personal)).toEqual(pending);
    expect(JSON.stringify(await f.remote().status(id, personal))).not.toContain('fictional-provider-secret');
  });

  it('lost acknowledgement of personal revoke claim prevents later retry or regrant', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal);
    f.dynamo.afterCommit = () => { f.dynamo.afterCommit = undefined; throw new Error('fictional-lost-ack'); };
    await expect(f.remote().revokeGoogleGrant(id, personal)).rejects.toThrow('fictional-lost-ack');
    const pending = await row(f, id, personal); const count = f.calls.length;
    expect(await f.remote().revokeGoogleGrant(id, personal)).toMatchObject({ providerRevocation: 'pending' });
    await expect(begun(f, id, personal)).rejects.toThrow('google_revocation_pending');
    expect(await row(f, id, personal)).toEqual(pending); expect(f.calls).toHaveLength(count);
  });

  it('personal revoke fences an in-flight callback and competing revoker cannot take ownership', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal); const url = await begun(f, id, personal);
    const remote = f.remote(async (url, init) => { const response = await f.fetch(url, init); if (String(url).endsWith('/userinfo')) await f.remote().revokeGoogleGrant(id, personal); return response; });
    await expect(remote.completeGoogleGrant(url.searchParams.get('state')!, 'fictional-code')).rejects.toThrow('TransactionCanceledException');
    expect((await f.remote().status(id, personal)).state).toBe('revoked');
    await install(f, id, personal);
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void; const claimed = new Promise<void>(resolve => { arrived = resolve; });
    const owner = f.remote(async (url, init) => { if (String(url).endsWith('/revoke')) { arrived(); await blocked; } return f.fetch(url, init); });
    const first = owner.revokeGoogleGrant(id, personal); await claimed;
    expect(await f.remote().revokeGoogleGrant(id, personal)).toMatchObject({ providerRevocation: 'pending' });
    release(); expect(await first).toMatchObject({ providerRevocation: 'confirmed' });
  });

  it.each([false, true])('retains selection with refresh rotation=%s and returns committed-revision evidence', async rotate => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal); f.expire(); f.refresh(rotate ? 'fictional-rotated' : undefined);
    const result = await access(f, id); const stored = (await row(f, id, personal))!;
    expect(result.grant).toMatchObject({ availabilityCalendars }); expect(result.accessEvidence.grantRevision).toBe(stored.rev);
    await f.auth.store.transact(f.remote().accessChecks(result.accessEvidence, { pairingId: id, subject: 'personal-B', requiredCapabilities: ['availability'], purpose: personal }));
    await f.remote().revokeGoogleGrant(id, personal);
    expect(new URLSearchParams(String(f.calls.at(-1)?.init?.body)).get('token')).toBe(rotate ? 'fictional-rotated' : 'fictional-refresh-personal-B');
  });

  it.each(['abort', 'revoke', 'pairing'] as const)('personal refresh %s prevents committing a replacement', async race => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal); const before = await row(f, id, personal); f.expire(); const controller = new AbortController();
    const remote = f.remote(async (url, init) => { const response = await f.fetch(url, init); if (String(url).endsWith('/userinfo')) {
      if (race === 'abort') controller.abort(); else if (race === 'revoke') await f.remote().revokeGoogleGrant(id, personal); else await f.auth.revokePairing(id);
    } return response; });
    await expect(remote.authorizedAccess(id, ['availability'], controller.signal, personal)).rejects.toThrow(race === 'abort' ? 'oauth_cancelled' : 'TransactionCanceledException');
    if (race === 'revoke') expect((await row(f, id, personal))?.data).toMatchObject({ revoked: true, ciphertext: null }); else expect(await row(f, id, personal)).toEqual(before);
  });

  it('concurrent personal refreshes have a single selected-row CAS winner', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal); f.expire();
    const results = await Promise.allSettled([access(f, id), access(f, id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await row(f, id, personal))?.rev).toBe(2);
  });

  it('purpose-bound evidence rejects legacy reinterpretation, altered claims, foreign scopes and expiry synchronously', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id); const work = await access(f, id, legacy); await install(f, id, personal); const result = await access(f, id);
    const expected = { pairingId: id, subject: 'personal-B', requiredCapabilities: ['availability'] as GoogleCapability[], purpose: personal };
    const checks = f.remote().accessChecks(result.accessEvidence, expected);
    expect(checks[1]?.ConditionCheck?.Key?.sk?.S).toBe(key(id, personal));
    expect(() => f.remote().accessChecks(result.accessEvidence, { ...expected, purpose: undefined })).toThrow('google_access_evidence_invalid');
    expect(() => f.remote().accessChecks(work.accessEvidence, { ...expected, subject: 'work-A', requiredCapabilities: ['send'] })).toThrow('google_access_evidence_invalid');
    for (const changed of [{ purpose: legacy }, { version: 1 }, { grantRevision: 200 }, { pairingRevision: 200 }, { tableName: 'foreign-table' }, { workspaceId: 'foreign-workspace' }, { pairingId: await paired(f) }, { subject: 'different-C' }, { requiredCapabilities: ['send'] }, { expiresAt: result.accessEvidence.expiresAt + 1000 }]) {
      expect(() => f.remote().accessChecks({ ...result.accessEvidence, ...changed } as GoogleAccessEvidence, expected)).toThrow('google_access_evidence_invalid');
    }
    expect(() => f.remote().accessChecks(result.accessEvidence, { ...expected, requiredCapabilities: ['event_write'] })).toThrow('google_access_evidence_invalid');
    await f.auth.store.transact(checks);
    f.expire(); expect(() => f.remote().accessChecks(result.accessEvidence, expected)).toThrow('google_access_evidence_invalid');
  });

  it.each(['refresh', 'revoke', 'pairing'] as const)('real final conditional transactions fence prepared personal evidence after %s', async action => {
    const f = fixture(); const id = await paired(f); await install(f, id); const work = await access(f, id, legacy); await install(f, id, personal); const prepared = await access(f, id);
    const checks = f.remote().accessChecks(prepared.accessEvidence, { pairingId: id, subject: 'personal-B', requiredCapabilities: ['availability'], purpose: personal });
    const workChecks = f.remote().accessChecks(work.accessEvidence, { pairingId: id, subject: 'work-A', requiredCapabilities: ['send'] });
    if (action === 'refresh') { f.expire(); await access(f, id); } else if (action === 'revoke') await f.remote().revokeGoogleGrant(id, personal); else await f.auth.revokePairing(id);
    await expect(f.auth.store.transact([...checks, f.auth.store.put(`FICTIONAL_RESERVATION#${action}`, { ok: true }, null)])).rejects.toThrow('TransactionCanceledException');
    expect(f.dynamo.inspect(`FICTIONAL_RESERVATION#${action}`)).toBeUndefined();
    if (action !== 'pairing') await f.auth.store.transact(workChecks); else await expect(f.auth.store.transact(workChecks)).rejects.toThrow('TransactionCanceledException');
  });

  it.each(['expiry', 'generation', 'client', 'redirect', 'pairing'] as const)('personal state %s mismatch fails before any provider request', async mismatch => {
    const f = fixture(); const id = await paired(f); const state = (await begun(f, id, personal)).searchParams.get('state')!;
    let remote = f.remote();
    if (mismatch === 'expiry') f.advance();
    if (mismatch === 'generation') await mutate(f, pairingKey(id), data => ({ ...data, generation: 1 }));
    if (mismatch === 'pairing') await f.auth.revokePairing(id);
    if (mismatch === 'client') remote = new RemoteGoogleAuthorization({ auth: f.auth, config: { ...f.config, clientId: 'different.apps.googleusercontent.com' }, fetch: f.fetch });
    if (mismatch === 'redirect') remote = new RemoteGoogleAuthorization({ auth: f.auth, config: { ...f.config, redirectUri: 'https://other.example.test/oauth/callback' }, fetch: f.fetch });
    await expect(remote.completeGoogleGrant(state, 'fictional-code')).rejects.toThrow(mismatch === 'pairing' ? 'worker_unauthorized' : 'oauth_state_unavailable');
    expect(f.calls).toHaveLength(0);
  });

  it('a pending legacy ambiguous cleanup row is untouched by personal begin, complete, refresh and revoke', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id); f.revocation('ambiguous');
    await f.remote().revokeGoogleGrant(id); const pendingWork = await row(f, id);
    await install(f, id, personal); f.expire(); await access(f, id);
    f.revocation('success'); await f.remote().revokeGoogleGrant(id, personal);
    expect(await row(f, id)).toEqual(pendingWork);
    await expect(begun(f, id)).rejects.toThrow('google_revocation_pending');
    const count = f.calls.length; await f.remote().revokeGoogleGrant(id); expect(f.calls).toHaveLength(count);
    expect(await row(f, id)).toEqual(pendingWork);
  });

  it('personal ciphertext cannot become a legacy token even with valid legacy metadata', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id); await install(f, id, personal);
    const privateRow = (await row(f, id, personal))!; const count = f.calls.length;
    await mutate(f, key(id), data => ({ ...data, ciphertext: privateRow.data.ciphertext }));
    await expect(access(f, id, legacy)).rejects.toThrow('google_secret_unavailable');
    expect(f.calls).toHaveLength(count);
  });

  it('personal cancellation and scope loss on refresh preserve the selected row', async () => {
    const f = fixture(); const id = await paired(f); await install(f, id, personal); const before = await row(f, id, personal);
    const state = (await begun(f, id, personal)).searchParams.get('state')!;
    await expect(f.remote().completeGoogleGrant(state, null)).rejects.toThrow('oauth_cancelled');
    await expect(f.remote().completeGoogleGrant(state, 'again')).rejects.toThrow('oauth_state_unavailable');
    expect(await row(f, id, personal)).toEqual(before);
    f.expire(); f.scope('openid email'); await expect(access(f, id)).rejects.toThrow('grant_missing_capability');
    expect(await row(f, id, personal)).toEqual(before);
  });

  it('identity email alias scope remains identity-only and unverified identity cannot install personal tokens', async () => {
    const f = fixture(); const id = await paired(f); f.account(personal);
    const state = (await begun(f, id, personal)).searchParams.get('state')!;
    const unverified = f.remote(async (url, init) => String(url).endsWith('/userinfo')
      ? Response.json({ sub: 'personal-B', email: 'private@example.test', email_verified: false }) : f.fetch(url, init));
    await expect(unverified.completeGoogleGrant(state, 'fictional-code')).rejects.toThrow('oauth_identity_invalid');
    expect(await row(f, id, personal)).toBeNull();
    const next = (await begun(f, id, personal)).searchParams.get('state')!;
    f.scope(`openid https://www.googleapis.com/auth/userinfo.email ${googleScopes.availability}`);
    expect((await f.remote().completeGoogleGrant(next, 'fictional-code')).grant).toMatchObject({ purpose: personal, capabilities: ['availability'] });
  });

});
