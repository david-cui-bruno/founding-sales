import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { authorityStateSchema, delegationCommandSchema, type DelegationCommand } from '../../../../src/shared/contracts/delegationContract';
import { accountIdSchema } from '../../../../src/shared/contracts/accountContract';
import { DynamoStore, fingerprint, keyPart, withDynamoReadErrors, type RepositoryOptions, type DynamoAdapter } from './dynamoStore';
export const workerScopeSchema = z.enum(['commands:write', 'events:read', 'google:grant', 'pairing:revoke', 'emergency:stop']);
export type WorkerScope = z.infer<typeof workerScopeSchema>;
export type WorkerPrincipal = { pairingId: string; workspaceId: string; generation: number; kind: 'device' | 'emergency'; scopes: WorkerScope[]; credentialHash: string };
export type PairingGrant = { pairingId: string; workspaceId: string; credential: string; emergencyCredential: string; scopes: WorkerScope[]; generation: number };
const scopesSchema = z.array(workerScopeSchema).min(1).max(5).refine(value => new Set(value).size === value.length);
const pairingSchema = z.strictObject({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), revoked: z.boolean() });
const tokenSchema = z.strictObject({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), kind: z.enum(['device', 'emergency']), scopes: scopesSchema });
/** A bootstrap without `kind` is the original fresh-pairing record; `kind: 'rotation'` names an existing pairing whose
 * credentials the redeemer replaces in place. Both are one-time codes with the same expiry and consumption rules. */
const bootstrapSchema = z.strictObject({ kind: z.literal('rotation').optional(), pairingId: z.string().uuid(), scopes: scopesSchema, expiresAt: z.number().finite(), consumed: z.boolean() });
/** The two scopes every desktop pairing needs; a rotation may never drop them. */
export const DESKTOP_PAIRING_SCOPES: readonly WorkerScope[] = ['commands:write', 'events:read'];
export const secretHash = (value: string): string => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const pairingKey = (id: string): string => `PAIRING#${keyPart(id)}`;
/** No default client, profile, network or operator bootstrap on construction. */
export class WorkerAuth {
  readonly store: DynamoStore;
  constructor(readonly options: RepositoryOptions) {
    this.options = { ...options, dynamo: withDynamoReadErrors(options.dynamo) };
    this.store = new DynamoStore(this.options);
  }
  /** Trusted operator composition only. Never exposed on the public HTTP handler. */
  async issuePairing(input: { scopes: WorkerScope[]; expiresInSeconds: number }): Promise<{ code: string; pairingId: string }> {
    const scopes = scopesSchema.parse(input.scopes);
    if (scopes.includes('emergency:stop')) throw new Error('worker_scope_denied');
    z.number().int().min(30).max(600).parse(input.expiresInSeconds);
    const code = secret(); const pairingId = randomUUID();
    await this.store.transact([this.store.put(`BOOTSTRAP#${secretHash(code)}`, { pairingId, scopes,
      expiresAt: Date.parse(this.store.now()) + input.expiresInSeconds * 1000, consumed: false }, null)]);
    return { code, pairingId };
  }
  /** Trusted operator composition only. Mints a one-time rotation code for an EXISTING, unrevoked pairing. Redeeming it
   * keeps the pairing id (and so every record bound to it) and replaces both credentials at the next generation with the
   * given scope set. Refuses an unknown or revoked pairing and a scope set that drops a desktop scope or adds emergency powers. */
  async issueRotation(input: { pairingId: string; scopes: WorkerScope[]; expiresInSeconds: number }): Promise<{ code: string; pairingId: string; generation: number }> {
    const scopes = scopesSchema.parse(input.scopes);
    if (scopes.includes('emergency:stop') || DESKTOP_PAIRING_SCOPES.some(scope => !scopes.includes(scope))) throw new Error('worker_scope_denied');
    z.number().int().min(30).max(600).parse(input.expiresInSeconds);
    const pairingId = z.string().uuid().parse(input.pairingId);
    let current: Awaited<ReturnType<WorkerAuth['activePairing']>>;
    try { current = await this.activePairing(pairingId); } catch { throw new Error('pairing_unavailable'); }
    const code = secret();
    await this.store.transact([this.store.put(`BOOTSTRAP#${secretHash(code)}`, { kind: 'rotation', pairingId, scopes,
      expiresAt: Date.parse(this.store.now()) + input.expiresInSeconds * 1000, consumed: false }, null)]);
    return { code, pairingId, generation: current.data.generation };
  }
  private async rateLimit(source: string): Promise<void> {
    if (!source || source.length > 256) throw new Error('pairing_rate_limited');
    const minute = Math.floor(Date.parse(this.store.now()) / 60000);
    const keys = [`PAIR_RATE#${minute}#${secretHash(source)}`, `PAIR_RATE#${minute}#global`];
    const records = await Promise.all(keys.map(key => this.store.get<{ count: number }>(key)));
    const counts = records.map(record => z.number().int().nonnegative().parse(record?.data.count ?? 0));
    if (counts[0]! >= 5 || counts[1]! >= 30) throw new Error('pairing_rate_limited');
    try {
      await this.store.transact(keys.map((key, i) => this.store.put(key, { count: counts[i]! + 1 }, records[i]?.rev ?? null, { ttl: (minute + 2) * 60 })));
    } catch { throw new Error('pairing_rate_limited'); }
  }
  async redeemPairing(code: string, rateLimitKey: string): Promise<PairingGrant> {
    await this.rateLimit(rateLimitKey);
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('pairing_unavailable');
    const key = `BOOTSTRAP#${secretHash(code)}`;
    const stored = await this.store.get<unknown>(key);
    const parsed = bootstrapSchema.safeParse(stored?.data);
    if (!stored || !parsed.success || parsed.data.consumed || parsed.data.expiresAt <= Date.parse(this.store.now())) throw new Error('pairing_unavailable');
    const { pairingId, scopes } = parsed.data;
    const credential = secret(); const emergencyCredential = secret();
    // A rotation bumps the existing pairing's generation under its own rev check, so the old device and emergency
    // credentials fail `credential()` the moment this commits; a fresh bootstrap creates the pairing at generation 0.
    let pairing: { rev: number | null; generation: number } = { rev: null, generation: 0 };
    if (parsed.data.kind === 'rotation') {
      try { const current = await this.activePairing(pairingId); pairing = { rev: current.rev, generation: current.data.generation + 1 }; }
      catch { throw new Error('pairing_unavailable'); }
    }
    try {
      await this.store.transact([
        this.store.put(key, { ...parsed.data, consumed: true }, stored.rev),
        this.store.put(pairingKey(pairingId), { pairingId, generation: pairing.generation, revoked: false }, pairing.rev),
        this.store.put(`TOKEN#${secretHash(credential)}`, { pairingId, generation: pairing.generation, kind: 'device', scopes }, null),
        this.store.put(`TOKEN#${secretHash(emergencyCredential)}`, { pairingId, generation: pairing.generation, kind: 'emergency', scopes: ['emergency:stop'] }, null),
      ]);
    } catch { throw new Error('pairing_unavailable'); }
    return { pairingId, workspaceId: this.options.workspaceId, credential, emergencyCredential, scopes, generation: pairing.generation };
  }
  async activePairing(pairingId: string) {
    const stored = await this.store.get<unknown>(pairingKey(pairingId));
    const parsed = pairingSchema.safeParse(stored?.data);
    if (!stored || !parsed.success || parsed.data.pairingId !== pairingId || parsed.data.revoked) throw new Error('worker_unauthorized');
    return { ...stored, data: parsed.data };
  }
  private async credential(hash: string, required: WorkerScope[]) {
    const stored = await this.store.get<unknown>(`TOKEN#${hash}`);
    const parsed = tokenSchema.safeParse(stored?.data);
    if (!stored || !parsed.success) throw new Error('worker_unauthorized');
    const pairing = await this.activePairing(parsed.data.pairingId);
    if (pairing.data.generation !== parsed.data.generation) throw new Error('worker_unauthorized');
    if (required.some(scope => !parsed.data.scopes.includes(scope))) throw new Error('worker_scope_denied');
    return { stored, pairing, principal: { ...parsed.data, workspaceId: this.options.workspaceId, credentialHash: hash } };
  }
  async authenticate(authorization: string | undefined, required: WorkerScope[]): Promise<WorkerPrincipal> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '');
    if (!match) throw new Error('worker_unauthorized');
    return (await this.credential(secretHash(match[1]!), required)).principal;
  }
  async revokePairing(pairingId: string): Promise<void> {
    const current = await this.activePairing(pairingId);
    await this.store.transact([this.store.put(pairingKey(pairingId), { ...current.data, generation: current.data.generation + 1, revoked: true }, current.rev)]);
  }
  async emergencyCommand(principal: WorkerPrincipal, input: unknown): Promise<DelegationCommand> {
    if (principal.kind !== 'emergency' || !principal.scopes.includes('emergency:stop')) throw new Error('worker_scope_denied');
    const request = z.strictObject({ commandId: accountIdSchema, accountId: accountIdSchema, kind: z.enum(['pause', 'revoke']), reason: z.string().trim().min(1).max(2000) }).parse(input);
    const store = new DynamoStore({ ...this.options, dynamo: this.fencedDynamo(principal) });
    const key = `EMERGENCY_COMMAND#${keyPart(request.commandId)}`;
    const fp = fingerprint({ pairingId: principal.pairingId, request });
    const replay = async () => {
      const previous = await store.get<{ fingerprint: string; command: unknown }>(key);
      if (!previous) return null;
      if (previous.data.fingerprint !== fp) throw new Error('command_fingerprint_conflict');
      return delegationCommandSchema.parse(previous.data.command);
    };
    const previous = await replay(); if (previous) return previous;
    const authority = await store.get<unknown>(`AUTH#${keyPart(request.accountId)}`);
    if (!authority) throw new Error('authority_missing');
    const current = z.strictObject({ authority: authorityStateSchema, version: z.number().int().nonnegative() }).parse(authority.data);
    if (current.authority.accountId !== request.accountId) throw new Error('authority_identity_conflict');
    const command = delegationCommandSchema.parse({ commandId: request.commandId, accountId: request.accountId,
      workspaceId: this.options.workspaceId, expectedAuthorityGeneration: current.authority.generation, expectedVersion: current.version,
      kind: request.kind, payload: { reason: request.reason } });
    try { await store.transact([store.put(key, { fingerprint: fp, command }, null)]); }
    catch (error) { const committed = await replay(); if (committed) return committed; throw error; }
    return command;
  }
  /** Add fresh credential/revocation CAS fences to actual C1 transactions. A
   * successful earlier HTTP authorization can never bypass a later revocation. */
  fencedDynamo(principal: WorkerPrincipal): DynamoAdapter {
    this.store.workspace(principal.workspaceId);
    return { send: async command => {
      const current = await this.credential(principal.credentialHash, principal.scopes);
      if (current.principal.pairingId !== principal.pairingId || current.principal.generation !== principal.generation) throw new Error('worker_unauthorized');
      if (!(command instanceof TransactWriteItemsCommand)) return this.options.dynamo.send(command);
      const items = command.input.TransactItems ?? [];
      if (items.length > 98) throw new Error('transaction_capacity_exceeded');
      return this.options.dynamo.send(new TransactWriteItemsCommand({ ...command.input, TransactItems: [...items,
        this.store.check(`TOKEN#${principal.credentialHash}`, current.stored.rev),
        this.store.check(pairingKey(principal.pairingId), current.pairing.rev),
      ] }));
    } };
  }
}
