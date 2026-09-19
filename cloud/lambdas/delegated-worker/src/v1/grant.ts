import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { capabilitiesForScopes, googleGrantSchema, googleScopes, type GoogleCapability, type GoogleGrant } from '../googleGrantCapabilities';
import type { RemoteGoogleConfig } from '../remoteGoogleAuthorization';
import type { DynamoStore } from '../dynamoStore';

/**
 * `GRANT#google`: the workspace's one mailbox grant under the rebuilt core (FSS target design section 2; slice S6).
 *
 * The design is explicit that this record is never copied from the old pairing-bound `GOOGLE_GRANT#<pairingId>`
 * one. It is created by a fresh consent at cutover, and the old grant is revoked afterwards. Two things follow.
 *
 * Binding version 2. The sealed refresh token is bound to the workspace, this sort key and the purpose, and to
 * nothing else — no pairing id, no generation. That is what makes the record independent of the pairings S7
 * deletes, and it is why the old ciphertext cannot be opened here even in principle: its additional authenticated
 * data names a pairing this binding does not carry, so an attempt to reuse it fails to decrypt rather than
 * silently succeeding.
 *
 * Device-bound state. The OAuth state is written against the device that asked for it (design section 3, auth), so
 * a callback can only complete a consent that this workspace's device actually began, and a revoked or replaced
 * device's half-finished consent completes for nobody. The state is single-use, ten minutes long, and carries the
 * PKCE verifier sealed under the same binding.
 *
 * Nothing here is a permission to send. Until the consent reaches `ready`, the mailbox seam answers
 * `mailbox_not_connected` and every send holds on exactly that reason.
 */

export const GOOGLE_GRANT_KEY = 'GRANT#google';
/** The state records this module writes. The carried pairing flow uses the same prefix with its own shape. */
export const OAUTH_STATE_PREFIX = 'OAUTH_STATE#';
export const GRANT_BINDING_VERSION = 2;
/** The mailbox capabilities the rebuilt core asks for, and nothing beyond them. */
export const GRANT_CAPABILITIES: readonly GoogleCapability[] = ['send', 'relevant_read'];
/** A consent begun and not finished inside this window is dead; David starts again. */
export const OAUTH_STATE_TTL_MS = 600_000;

const secret = z.string().min(1).max(16384).refine(value => !/[\r\n\x00]/.test(value)); // eslint-disable-line no-control-regex
const tokenSchema = z.object({ access_token: secret, refresh_token: secret.optional(), token_type: z.literal('Bearer'),
  expires_in: z.number().int().min(60).max(86400), scope: z.string().min(1).max(4000) });
const identitySchema = z.object({ sub: z.string().min(1).max(255), email: z.string().email().max(254), email_verified: z.literal(true) });
const tokensSchema = z.strictObject({ accessToken: secret, refreshToken: secret, expiresAt: z.number().finite() });

/** `GRANT#google`. One item: the identity and capabilities in the clear, the tokens sealed. */
export const grantRecordSchema = z.strictObject({
  version: z.literal(1),
  bindingVersion: z.literal(GRANT_BINDING_VERSION),
  grant: googleGrantSchema.nullable(),
  status: z.enum(['ready', 'revoked']),
  ciphertext: z.string().nullable(),
  /** The device that completed the consent, for Diagnostics. Never a token and never a credential. */
  consentedBy: z.string().uuid().nullable(),
  consentedAt: z.iso.datetime({ precision: 3 }).nullable(),
  updatedAt: z.iso.datetime({ precision: 3 }),
});
export type GrantRecord = z.infer<typeof grantRecordSchema>;

/** The device-bound OAuth state of a version-2 consent. Deliberately not the carried pairing state's shape. */
export const deviceOauthStateSchema = z.strictObject({
  bindingVersion: z.literal(GRANT_BINDING_VERSION),
  deviceId: z.string().uuid(),
  expiresAt: z.number().finite(),
  consumed: z.boolean(),
  capabilities: z.array(z.enum(['send', 'relevant_read', 'availability', 'event_write'])).min(1).max(4),
  verifier: z.string().min(1).max(4096),
  clientId: z.string().min(1).max(512),
  redirectUri: z.string().min(1).max(2048),
  /** The revision of `GRANT#google` when the consent began; a record that moved since invalidates the callback. */
  grantRevision: z.number().int().positive().nullable(),
});
export type DeviceOauthState = z.infer<typeof deviceOauthStateSchema>;

export const stateKey = (state: string): string => `${OAUTH_STATE_PREFIX}${createHash('sha256').update(state).digest('hex')}`;

/** Binding version 2: the workspace, this sort key and the purpose. No pairing id, no generation. */
function aad(store: DynamoStore, purpose: string): Buffer {
  return Buffer.from(JSON.stringify({ version: GRANT_BINDING_VERSION, workspaceId: store.options.workspaceId, sortKey: GOOGLE_GRANT_KEY, purpose }));
}
export function sealUnderBindingTwo(store: DynamoStore, key: Buffer, value: unknown, purpose: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(store, purpose));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function openUnderBindingTwo(store: DynamoStore, key: Buffer, value: string, purpose: string): unknown {
  try {
    const [version, iv, tag, body, extra] = value.split('.');
    if (version !== 'v2' || !iv || !tag || !body || extra) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(aad(store, purpose)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
  } catch { throw new Error('google_secret_unavailable'); }
}

export async function readGrant(store: DynamoStore): Promise<{ record: GrantRecord; rev: number } | null> {
  const row = await store.get<unknown>(GOOGLE_GRANT_KEY);
  if (!row) return null;
  const parsed = grantRecordSchema.safeParse(row.data);
  return parsed.success ? { record: parsed.data, rev: row.rev } : null;
}

export type GrantView = { status: 'connected' | 'not_connected' | 'revoked'; email: string | null; consentedAt: string | null };
/** What Settings says about the new grant. A read, never a refresh and never a provider call. */
export function grantView(held: { record: GrantRecord } | null): GrantView {
  if (!held || held.record.grant === null) return { status: 'not_connected', email: null, consentedAt: null };
  return { status: held.record.status === 'ready' ? 'connected' : 'revoked',
    email: held.record.grant.email, consentedAt: held.record.consentedAt };
}

export type GrantBeginRefusal = 'google_unconfigured' | 'already_connected';
export type GrantBeginResult = { outcome: 'begun'; authorizationUrl: string } | { outcome: 'refused'; reason: GrantBeginRefusal };

/**
 * Step one of the fresh consent: write the device-bound state, return the URL the client opens in the browser.
 * It writes a state record and nothing else — no grant, no token, no permission — and a workspace that already
 * holds a ready grant is refused rather than quietly starting a second consent over the first.
 */
export async function beginDeviceGrant(store: DynamoStore, config: RemoteGoogleConfig | undefined,
  input: { deviceId: string }): Promise<GrantBeginResult> {
  if (!config) return { outcome: 'refused', reason: 'google_unconfigured' };
  const held = await readGrant(store);
  if (held && held.record.status === 'ready' && held.record.grant !== null) return { outcome: 'refused', reason: 'already_connected' };
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const key = stateKey(state);
  const record: DeviceOauthState = deviceOauthStateSchema.parse({
    bindingVersion: GRANT_BINDING_VERSION, deviceId: input.deviceId, expiresAt: Date.parse(store.now()) + OAUTH_STATE_TTL_MS,
    consumed: false, capabilities: [...GRANT_CAPABILITIES],
    verifier: sealUnderBindingTwo(store, config.encryptionKey, verifier, `oauth-verifier:${key}`),
    clientId: config.clientId, redirectUri: config.redirectUri, grantRevision: held?.rev ?? null });
  await store.transact([store.put(key, record, null)]);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
    scope: ['openid', 'email', ...GRANT_CAPABILITIES.map(capability => googleScopes[capability])].join(' '), state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'false' }).toString();
  return { outcome: 'begun', authorizationUrl: url.href };
}

/** Whether this state record is a version-2 device-bound one, so the callback knows which flow it is completing. */
export async function isDeviceGrantState(store: DynamoStore, state: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return false;
  const row = await store.get<unknown>(stateKey(state));
  return row !== null && deviceOauthStateSchema.safeParse(row.data).success;
}

export type GrantCompleteResult = { outcome: 'ready'; grant: GoogleGrant } | { outcome: 'refused'; reason: string };

/**
 * Step two: the callback. The state is consumed first, in its own transaction, so a replayed callback cannot run
 * the exchange twice whatever the provider does afterwards. Only then are the code and the identity exchanged,
 * and the record is written with the tokens sealed under binding version 2.
 */
export async function completeDeviceGrant(store: DynamoStore, config: RemoteGoogleConfig | undefined,
  fetchImpl: typeof globalThis.fetch, input: { state: string; code: string | null }): Promise<GrantCompleteResult> {
  if (!config) return { outcome: 'refused', reason: 'google_unconfigured' };
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.state)) return { outcome: 'refused', reason: 'oauth_state_unavailable' };
  const key = stateKey(input.state);
  const row = await store.get<unknown>(key);
  const parsed = row ? deviceOauthStateSchema.safeParse(row.data) : null;
  if (!row || !parsed?.success || parsed.data.consumed || parsed.data.expiresAt <= Date.parse(store.now())
    || parsed.data.clientId !== config.clientId || parsed.data.redirectUri !== config.redirectUri) {
    return { outcome: 'refused', reason: 'oauth_state_unavailable' };
  }
  const state = parsed.data;
  const held = await readGrant(store);
  if ((held?.rev ?? null) !== state.grantRevision) return { outcome: 'refused', reason: 'oauth_state_unavailable' };
  const verifier = z.string().regex(/^[A-Za-z0-9_-]{64}$/).parse(openUnderBindingTwo(store, config.encryptionKey, state.verifier, `oauth-verifier:${key}`));
  // Consume before the exchange: a replayed callback finds a consumed state and does nothing at all.
  try { await store.transact([store.put(key, { ...state, consumed: true, verifier: '' }, row.rev)]); }
  catch { return { outcome: 'refused', reason: 'oauth_state_unavailable' }; }
  if (input.code === null) return { outcome: 'refused', reason: 'oauth_cancelled' };
  if (!secret.max(4096).safeParse(input.code).success) return { outcome: 'refused', reason: 'oauth_state_unavailable' };

  let exchanged: { token: z.infer<typeof tokenSchema>; grant: GoogleGrant };
  try {
    exchanged = await exchange(fetchImpl, config, { code: input.code, verifier, capabilities: state.capabilities as GoogleCapability[] });
  } catch (error) { return { outcome: 'refused', reason: error instanceof Error ? error.message : 'google_provider_rejected' }; }
  if (!exchanged.token.refresh_token) return { outcome: 'refused', reason: 'google_provider_rejected' };
  const now = store.now();
  const record = grantRecordSchema.parse({ version: 1, bindingVersion: GRANT_BINDING_VERSION, grant: exchanged.grant, status: 'ready',
    ciphertext: sealUnderBindingTwo(store, config.encryptionKey, { accessToken: exchanged.token.access_token,
      refreshToken: exchanged.token.refresh_token, expiresAt: Date.parse(now) + exchanged.token.expires_in * 1000 }, 'google-tokens'),
    consentedBy: state.deviceId, consentedAt: now, updatedAt: now });
  await store.transact([store.put(GOOGLE_GRANT_KEY, record, held?.rev ?? null)]);
  return { outcome: 'ready', grant: exchanged.grant };
}

async function request(fetchImpl: typeof globalThis.fetch, url: string, init: RequestInit): Promise<Response> {
  try { return await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error('google_provider_unavailable'); }
}
async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error('google_provider_rejected');
  const text = await response.text();
  if (text.length > 65536) throw new Error('google_provider_rejected');
  try { return JSON.parse(text); } catch { throw new Error('google_provider_rejected'); }
}

/** The code and identity exchange, with exactly the carried scope discipline: nothing beyond what was asked for. */
async function exchange(fetchImpl: typeof globalThis.fetch, config: RemoteGoogleConfig,
  input: { code: string; verifier: string; capabilities: GoogleCapability[] }): Promise<{ token: z.infer<typeof tokenSchema>; grant: GoogleGrant }> {
  const token = tokenSchema.safeParse(await json(await request(fetchImpl, 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
      grant_type: 'authorization_code', code: input.code, code_verifier: input.verifier }) })));
  if (!token.success) throw new Error('google_provider_rejected');
  const scopes = [...new Set(token.data.scope.split(/\s+/))];
  const capabilities = capabilitiesForScopes(scopes);
  if (input.capabilities.some(capability => !capabilities.includes(capability))) throw new Error('grant_missing_capability');
  const identityScopes = ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
  if (!scopes.includes('openid') || !scopes.some(scope => scope === 'email' || scope === identityScopes[2])
    || scopes.some(scope => !identityScopes.includes(scope) && !input.capabilities.some(capability => googleScopes[capability] === scope))) {
    throw new Error('google_scope_unapproved');
  }
  const identity = identitySchema.safeParse(await json(await request(fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.data.access_token}` } })));
  if (!identity.success) throw new Error('oauth_identity_invalid');
  const grant = googleGrantSchema.parse({ provider: 'google', subject: identity.data.sub, email: identity.data.email,
    grantedScopes: scopes, capabilities, owner: 'remote', purpose: 'permitted_correspondence' });
  return { token: token.data, grant };
}

export type GrantAccess = { connected: true; email: string; subject: string; accessToken: string } | { connected: false; reason: 'mailbox_not_connected' };

/**
 * The access token the send fence and the poller ask for, refreshed when it is stale. A refusal is always the same
 * closed answer — `mailbox_not_connected` — because a grant that cannot produce a token is not a connected mailbox,
 * whether it was revoked, never created, or refused by the provider just now.
 */
export async function grantAccess(store: DynamoStore, config: RemoteGoogleConfig | undefined,
  fetchImpl: typeof globalThis.fetch): Promise<GrantAccess> {
  if (!config) return { connected: false, reason: 'mailbox_not_connected' };
  const held = await readGrant(store);
  if (!held || held.record.status !== 'ready' || held.record.grant === null || held.record.ciphertext === null) {
    return { connected: false, reason: 'mailbox_not_connected' };
  }
  let tokens: z.infer<typeof tokensSchema>;
  try { tokens = tokensSchema.parse(openUnderBindingTwo(store, config.encryptionKey, held.record.ciphertext, 'google-tokens')); }
  catch { return { connected: false, reason: 'mailbox_not_connected' }; }
  const now = Date.parse(store.now());
  if (tokens.expiresAt > now + 60_000) {
    return { connected: true, email: held.record.grant.email, subject: held.record.grant.subject, accessToken: tokens.accessToken };
  }
  let refreshed: z.infer<typeof tokenSchema>;
  try {
    const parsed = tokenSchema.safeParse(await json(await request(fetchImpl, 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'refresh_token', refresh_token: tokens.refreshToken }) })));
    if (!parsed.success) return { connected: false, reason: 'mailbox_not_connected' };
    refreshed = parsed.data;
  } catch { return { connected: false, reason: 'mailbox_not_connected' }; }
  const next = { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    expiresAt: now + refreshed.expires_in * 1000 };
  try {
    await store.transact([store.put(GOOGLE_GRANT_KEY, grantRecordSchema.parse({ ...held.record,
      ciphertext: sealUnderBindingTwo(store, config.encryptionKey, next, 'google-tokens'), updatedAt: store.now() }), held.rev)]);
  } catch { /* Another reader refreshed first; the token in hand is still good for this request. */ }
  return { connected: true, email: held.record.grant.email, subject: held.record.grant.subject, accessToken: next.accessToken };
}
