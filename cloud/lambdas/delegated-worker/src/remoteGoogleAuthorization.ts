import type { TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type WorkerAuth, pairingKey, secretHash } from './workerAuth';
import { keyPart } from './dynamoStore';
import { googleCalendarSelectionSchema, type GoogleCalendarSelection, capabilitiesForScopes, googleCapabilitySchema, googleGrantSchema, googleScopes, requireCapabilities, type GoogleCapability, type GoogleGrant } from './googleGrantCapabilities';
export type RemoteGoogleConfig = { clientId: string; clientSecret: string; redirectUri: string; encryptionKey: Buffer };
export type GrantStatus = { state: 'unconfigured' | 'ready' | 'revoked'; grant: GoogleGrant | null; providerRevocation?: 'confirmed' | 'pending' };
const secret = z.string().min(1).max(16384).refine(value => !/[\r\n\x00]/.test(value)); // eslint-disable-line no-control-regex
const tokenSchema = z.object({ access_token: secret, refresh_token: secret.optional(), token_type: z.literal('Bearer'), expires_in: z.number().int().min(60).max(86400), scope: z.string().min(1).max(4000) });
const identitySchema = z.object({ sub: z.string().min(1).max(255), email: z.string().email().max(254), email_verified: z.literal(true) });
const capabilitiesSchema = z.array(googleCapabilitySchema).min(1).max(4).refine(value => new Set(value).size === value.length);
const accessEvidencePayloadSchema = z.strictObject({ version: z.literal(1), workspaceId: z.string().min(1), tableName: z.string().min(1),
  pairingId: z.string().uuid(), pairingRevision: z.number().int().positive(), grantRevision: z.number().int().positive(),
  subject: z.string().min(1).max(255), requiredCapabilities: capabilitiesSchema, expiresAt: z.number().finite().positive() });
const accessEvidenceSchema = accessEvidencePayloadSchema.extend({ proof: z.string().regex(/^[a-f0-9]{64}$/) });
export type GoogleAccessEvidence = z.infer<typeof accessEvidenceSchema>;
export type ExpectedGoogleAccess = { pairingId: string; subject: string; requiredCapabilities: GoogleCapability[] };
export type AuthorizedGoogleAccess = { accessToken: string; grant: GoogleGrant; accessEvidence: GoogleAccessEvidence };
const stateSchema = z.strictObject({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), expiresAt: z.number(), consumed: z.boolean(),
  calendars: googleCalendarSelectionSchema.optional(), capabilities: capabilitiesSchema, verifier: z.string(), grantRevision: z.number().int().positive().nullable(), subject: z.string().nullable(), clientId: z.string(), redirectUri: z.string() });
const recordSchema = z.strictObject({ grant: googleGrantSchema.nullable(), revoked: z.boolean(), ciphertext: z.string().nullable(), providerRevocation: z.enum(['confirmed', 'pending']).optional() });
const tokensSchema = z.strictObject({ accessToken: secret, refreshToken: secret, expiresAt: z.number().finite() });
const grantKey = (pairingId: string) => `GOOGLE_GRANT#${keyPart(pairingId)}`;
/** Durable state and tokens use C1 DynamoStore, with AES-256-GCM bound to the
 * workspace, pairing, purpose and envelope version. No process replay cache. */
export class RemoteGoogleAuthorization {
  constructor(readonly input: { auth: WorkerAuth; config?: RemoteGoogleConfig; fetch?: typeof globalThis.fetch }) {}
  private get store() { return this.input.auth.store; }
  private config(): RemoteGoogleConfig {
    const config = this.input.config;
    if (!config) throw new Error('google_unconfigured');
    const redirect = new URL(config.redirectUri);
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/oauth/callback'
      || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(config.clientId) || !secret.safeParse(config.clientSecret).success
      || config.encryptionKey.length !== 32) throw new Error('google_unconfigured');
    return config;
  }
  private aad(pairingId: string, purpose: string): Buffer {
    return Buffer.from(JSON.stringify({ version: 1, workspaceId: this.store.options.workspaceId, pairingId, purpose }));
  }
  private seal(value: unknown, pairingId: string, purpose: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.config().encryptionKey, iv);
    cipher.setAAD(this.aad(pairingId, purpose));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
  }
  private open(value: string, pairingId: string, purpose: string): unknown {
    try {
      const [version, iv, tag, body, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !body || extra) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.config().encryptionKey, Buffer.from(iv, 'base64url'));
      decipher.setAAD(this.aad(pairingId, purpose)); decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
    } catch { throw new Error('google_secret_unavailable'); }
  }
  private async record(pairingId: string) {
    const stored = await this.store.get<unknown>(grantKey(pairingId));
    return stored ? { ...stored, data: recordSchema.parse(stored.data) } : null;
  }
  async beginGoogleGrant(pairingId: string, capabilities: GoogleCapability[], calendars?: GoogleCalendarSelection): Promise<{ authorizationUrl: string }> {
    const config = this.config(); const wanted = capabilitiesSchema.parse(capabilities);
    if (wanted.some(c => c === 'availability' || c === 'event_write') && !googleCalendarSelectionSchema.safeParse(calendars).success) throw new Error('google_calendar_selection_required');
    const selected = calendars ? googleCalendarSelectionSchema.parse(calendars) : undefined;
    const pairing = await this.input.auth.activePairing(pairingId); const previous = await this.record(pairingId);
    // Do not silently drop previously granted powers on an incomplete reauthorization.
    if (previous?.data.grant && !previous.data.revoked && previous.data.grant.capabilities.some(c => !wanted.includes(c))) throw new Error('grant_missing_capability');
    const state = randomBytes(32).toString('base64url'); const key = `OAUTH_STATE#${secretHash(state)}`;
    const verifier = randomBytes(48).toString('base64url');
    await this.store.transact([this.store.check(pairingKey(pairingId), pairing.rev),
      previous ? this.store.check(grantKey(pairingId), previous.rev) : this.store.absent(grantKey(pairingId)),
      this.store.put(key, { pairingId, generation: pairing.data.generation, expiresAt: Date.parse(this.store.now()) + 600000, consumed: false,
        ...(selected ? { calendars: selected } : {}), capabilities: wanted, verifier: this.seal(verifier, pairingId, key), grantRevision: previous?.rev ?? null,
        subject: previous?.data.grant?.subject ?? null, clientId: config.clientId, redirectUri: config.redirectUri }, null)]);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
      scope: ['openid', 'email', ...wanted.map(capability => googleScopes[capability])].join(' '), state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline',
      prompt: 'consent select_account', include_granted_scopes: 'false' }).toString();
    return { authorizationUrl: url.href };
  }
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try { return await (this.input.fetch ?? globalThis.fetch)(url, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
    catch { throw new Error('google_provider_unavailable'); }
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error('google_provider_rejected');
    const text = await response.text();
    if (text.length > 65536) throw new Error('google_provider_rejected');
    try { return JSON.parse(text); } catch { throw new Error('google_provider_rejected'); }
  }
  private async exchange(body: URLSearchParams, required: GoogleCapability[], expectedSubject: string | null, signal?: AbortSignal) {
    const token = tokenSchema.safeParse(await this.json(await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, signal)));
    if (!token.success) throw new Error('google_provider_rejected');
    const scopes = [...new Set(token.data.scope.split(/\s+/))];
    const capabilities = capabilitiesForScopes(scopes);
    if (required.some(c => !capabilities.includes(c))) throw new Error('grant_missing_capability');
    const identityScopes = ['openid', 'email', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];
    if (!scopes.includes('openid') || !scopes.some(s => s === 'email' || s === identityScopes[2])
      || scopes.some(s => !identityScopes.includes(s) && !required.some(c => googleScopes[c] === s))) throw new Error('google_scope_unapproved');
    const identity = identitySchema.safeParse(await this.json(await this.request('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.data.access_token}` } }, signal)));
    if (!identity.success) throw new Error('oauth_identity_invalid');
    if (expectedSubject && identity.data.sub !== expectedSubject) throw new Error('oauth_subject_mismatch');
    const grant = googleGrantSchema.parse({ provider: 'google', subject: identity.data.sub, email: identity.data.email, grantedScopes: scopes,
      capabilities, owner: 'remote', purpose: 'permitted_correspondence' });
    requireCapabilities(grant, required);
    return { token: token.data, grant };
  }
  async completeGoogleGrant(state: string, code: string | null): Promise<GrantStatus> {
    const config = this.config();
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('oauth_state_unavailable');
    const key = `OAUTH_STATE#${secretHash(state)}`; const stored = await this.store.get<unknown>(key);
    const parsed = stateSchema.safeParse(stored?.data);
    if (!stored || !parsed.success || parsed.data.consumed || parsed.data.expiresAt <= Date.parse(this.store.now())
      || parsed.data.clientId !== config.clientId || parsed.data.redirectUri !== config.redirectUri) throw new Error('oauth_state_unavailable');
    const data = parsed.data; const pairing = await this.input.auth.activePairing(data.pairingId);
    const previous = await this.record(data.pairingId);
    if (pairing.data.generation !== data.generation || (previous?.rev ?? null) !== data.grantRevision) throw new Error('oauth_state_unavailable');
    const verifier = z.string().regex(/^[A-Za-z0-9_-]{64}$/).parse(this.open(data.verifier, data.pairingId, key));
    try {
      await this.store.transact([this.store.put(key, { ...data, consumed: true, verifier: '' }, stored.rev),
        this.store.check(pairingKey(data.pairingId), pairing.rev),
        previous ? this.store.check(grantKey(data.pairingId), previous.rev) : this.store.absent(grantKey(data.pairingId))]);
    } catch { throw new Error('oauth_state_unavailable'); }
    if (code === null) throw new Error('oauth_cancelled');
    if (!secret.max(4096).safeParse(code).success) throw new Error('oauth_state_unavailable');
    const { token, grant } = await this.exchange(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      redirect_uri: config.redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier }), data.capabilities, data.subject);
    if (data.calendars) grant.calendars = data.calendars;
    if (!token.refresh_token) throw new Error('google_provider_rejected');
    const ciphertext = this.seal({ accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: Date.parse(this.store.now()) + token.expires_in * 1000 }, data.pairingId, 'google-tokens');
    await this.store.transact([this.store.check(pairingKey(data.pairingId), pairing.rev),
      this.store.put(grantKey(data.pairingId), { grant, revoked: false, ciphertext }, previous?.rev ?? null)]);
    return { state: 'ready', grant };
  }
  async status(pairingId: string): Promise<GrantStatus> {
    await this.input.auth.activePairing(pairingId);
    const record = await this.record(pairingId);
    if (!record) return { state: 'unconfigured', grant: null };
    return { state: record.data.revoked ? 'revoked' : 'ready', grant: record.data.grant,
      ...(record.data.providerRevocation ? { providerRevocation: record.data.providerRevocation } : {}) };
  }
  async revokeGoogleGrant(pairingId: string): Promise<GrantStatus> {
    const pairing = await this.input.auth.activePairing(pairingId); const record = await this.record(pairingId);
    const grant = record?.data.grant ?? null;
    // Fence every pending OAuth callback first. Keep encrypted tokens only while
    // provider revocation is pending, inaccessible to authorizedAccess.
    const pending = { grant, revoked: true, ciphertext: record?.data.ciphertext ?? null, providerRevocation: 'pending' as const };
    await this.store.transact([this.store.check(pairingKey(pairingId), pairing.rev), this.store.put(grantKey(pairingId), pending, record?.rev ?? null)]);
    if (pending.ciphertext) {
      try {
        const tokens = tokensSchema.parse(this.open(pending.ciphertext, pairingId, 'google-tokens'));
        const response = await this.request('https://oauth2.googleapis.com/revoke', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refreshToken }) });
        if (!response.ok) return { state: 'revoked', grant, providerRevocation: 'pending' };
      } catch { return { state: 'revoked', grant, providerRevocation: 'pending' }; }
    }
    await this.store.transact([this.store.put(grantKey(pairingId), { grant, revoked: true, ciphertext: null, providerRevocation: 'confirmed' }, (record?.rev ?? 0) + 1)]);
    return { state: 'revoked', grant, providerRevocation: 'confirmed' };
  }
  private accessProof(payload: z.infer<typeof accessEvidencePayloadSchema>): string {
    return createHmac('sha256', this.config().encryptionKey).update('google-access-evidence-v1\n')
      .update(JSON.stringify(accessEvidencePayloadSchema.parse(payload))).digest('hex');
  }
  private accessEvidence(pairingId: string, pairingRevision: number, grantRevision: number, grant: GoogleGrant,
    requiredCapabilities: GoogleCapability[], expiresAt: number): GoogleAccessEvidence {
    if (grant.owner !== 'remote') throw new Error('google_access_evidence_invalid');
    requireCapabilities(grant, requiredCapabilities);
    const payload = accessEvidencePayloadSchema.parse({ version: 1, workspaceId: this.store.options.workspaceId, tableName: this.store.options.tableName,
      pairingId, pairingRevision, grantRevision, subject: grant.subject, requiredCapabilities, expiresAt });
    return { ...payload, proof: this.accessProof(payload) };
  }
  /** Synchronous composition only: include BOTH conditions in the same final
   * reservation transaction. Calling this is not itself an authorization check.
   * Evidence is authenticated, but is neither a token nor recipient permission. */
  accessChecks(evidence: GoogleAccessEvidence, expected: ExpectedGoogleAccess): TransactWriteItem[] {
    try {
      const { proof, ...payload } = accessEvidenceSchema.parse(evidence);
      const required = capabilitiesSchema.parse(expected.requiredCapabilities);
      if (payload.workspaceId !== this.store.options.workspaceId || payload.tableName !== this.store.options.tableName
        || payload.pairingId !== expected.pairingId || payload.subject !== expected.subject
        || required.some(capability => !payload.requiredCapabilities.includes(capability))
        || payload.expiresAt <= Date.parse(this.store.now())
        || !timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(this.accessProof(payload), 'hex'))) throw new Error();
      return [this.store.check(pairingKey(payload.pairingId), payload.pairingRevision),
        this.store.check(grantKey(payload.pairingId), payload.grantRevision)];
    } catch { throw new Error('google_access_evidence_invalid'); }
  }
  /** Remote-only provider binding. Never expose this result from an HTTP route. */
  async authorizedAccess(pairingId: string, required: GoogleCapability[], signal?: AbortSignal): Promise<AuthorizedGoogleAccess> {
    if (signal?.aborted) throw new Error('oauth_cancelled');
    const wanted = capabilitiesSchema.parse(required);
    const pairing = await this.input.auth.activePairing(pairingId); const record = await this.record(pairingId);
    if (!record || record.data.revoked || !record.data.grant || !record.data.ciphertext) throw new Error('google_grant_unavailable');
    requireCapabilities(record.data.grant, wanted);
    const tokens = tokensSchema.parse(this.open(record.data.ciphertext, pairingId, 'google-tokens'));
    if (tokens.expiresAt > Date.parse(this.store.now()) + 60000) return { accessToken: tokens.accessToken, grant: record.data.grant,
      accessEvidence: this.accessEvidence(pairingId, pairing.rev, record.rev, record.data.grant, wanted, tokens.expiresAt) };
    const config = this.config();
    const { token, grant } = await this.exchange(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      grant_type: 'refresh_token', refresh_token: tokens.refreshToken }), record.data.grant.capabilities, record.data.grant.subject, signal);
    if (signal?.aborted) throw new Error('oauth_cancelled');
    if (record.data.grant.calendars) grant.calendars = record.data.grant.calendars;
    const expiresAt = Date.parse(this.store.now()) + token.expires_in * 1000;
    const ciphertext = this.seal({ accessToken: token.access_token, refreshToken: token.refresh_token ?? tokens.refreshToken, expiresAt }, pairingId, 'google-tokens');
    await this.store.transact([this.store.check(pairingKey(pairingId), pairing.rev), this.store.put(grantKey(pairingId), { grant, revoked: false, ciphertext }, record.rev)]);
    return { accessToken: token.access_token, grant, accessEvidence: this.accessEvidence(pairingId, pairing.rev, record.rev + 1, grant, wanted, expiresAt) };
  }
}
