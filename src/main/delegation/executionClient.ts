import {requestedFollowupDraftSchema,type RequestedFollowupDraft,prepareRequestedFollowupSchema,type PrepareRequestedFollowup} from '../../shared/contracts/requestedFollowupContract';
import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../../shared/contracts/workerPolicyContract';
import { requestedOwnerContextSchema, ownerCheckpointSchema, configureResearchSourceSchema, ownerResearchSourceSchema } from '../../shared/contracts/ownerCommandContract';
import { z } from 'zod';
import { googleGrantPurposeSchema, googleScopes, googleGrantDisclosure, personalGoogleGrantDisclosure, type GoogleGrantPurpose } from '../../shared/contracts/googleGrantCapabilities';
import { remoteGoogleGrantAuthorizationSchema, remoteGoogleGrantBeginSchema, remoteGoogleGrantDisclosureSchema, remoteGoogleGrantStatusSchema, type RemoteGoogleGrantBegin, type RemoteGoogleGrantStatus } from '../../shared/contracts/remoteGoogleGrantContract';
import type { DelegationRepository } from './delegationRepository';
import { commandReceiptSchema, delegationCommandSchema, eventPageSchema, type CommandReceipt, type DelegationCommand } from '../../shared/contracts/delegationContract';
import { synchronizeDelegation, type SqlDelegationTransport, type SyncReport } from './delegationSync';
export type { SyncReport } from './delegationSync';
export type ExecutionPairing = Readonly<{ endpoint: string; workspaceId: string; credential: string }>;
export class ExecutionClient {
  private readonly pairing: ExecutionPairing;
  private readonly http: typeof globalThis.fetch;
  private readonly repository: DelegationRepository;
  private readonly transport: SqlDelegationTransport;
  private readonly signal: AbortSignal;
  constructor(options: { repository: DelegationRepository; transport: SqlDelegationTransport; pairing: ExecutionPairing; fetch?: typeof globalThis.fetch; signal?: AbortSignal }) {
    const pairing = z.strictObject({ endpoint: z.string().url(), workspaceId: z.string().min(1), credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(options.pairing);
    const endpoint = new URL(pairing.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Invalid worker endpoint');
    this.pairing = Object.freeze({ ...pairing, endpoint: endpoint.origin });
    this.http = options.fetch ?? globalThis.fetch;
    this.repository = options.repository;
    this.transport = options.transport;
    this.signal = options.signal ?? new AbortController().signal;
  }
  private async request(path: string, signal: AbortSignal, command?: unknown): Promise<unknown> {
    signal = AbortSignal.any([signal,this.signal]);
    signal.throwIfAborted();
    const response = await this.http(`${this.pairing.endpoint}${path}`, { method: command ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${this.pairing.credential}`, 'content-type': 'application/json' }, redirect: 'error', cache: 'no-store',
      signal, ...(command ? { body: JSON.stringify(command) } : {}) });
    signal.throwIfAborted();
    if (!response.ok) throw new Error('Worker request unavailable');
    const text = await response.text();
    signal.throwIfAborted();
    if (text.length > 4 * 1024 * 1024) throw new Error('Worker response too large');
    return JSON.parse(text) as unknown;
  }
  private grantStatus(raw: unknown, purpose: GoogleGrantPurpose): RemoteGoogleGrantStatus {
    const status = remoteGoogleGrantStatusSchema.parse(raw);
    if (status.grant && status.grant.purpose !== purpose) throw Error('Worker grant purpose mismatch');
    return status;
  }
  async googleGrantStatus(rawPurpose: GoogleGrantPurpose, signal: AbortSignal): Promise<RemoteGoogleGrantStatus> {
    const purpose = googleGrantPurposeSchema.parse(rawPurpose);
    return this.grantStatus(await this.request(`/google/status?purpose=${purpose}`, signal), purpose);
  }
  async googleGrantDisclosure(rawPurpose: GoogleGrantPurpose, signal: AbortSignal) {
    const purpose = googleGrantPurposeSchema.parse(rawPurpose);
    const result = remoteGoogleGrantDisclosureSchema.parse(await this.request(`/google/disclosure?purpose=${purpose}`, signal));
    const expected = purpose === 'personal_availability' ? personalGoogleGrantDisclosure : googleGrantDisclosure;
    if (result.version !== expected.version) throw Error('Worker disclosure purpose mismatch');
    return result;
  }
  async beginGoogleGrant(raw: RemoteGoogleGrantBegin, signal: AbortSignal): Promise<{ authorizationUrl: string }> {
    const input = remoteGoogleGrantBeginSchema.parse(raw);
    const result = remoteGoogleGrantAuthorizationSchema.parse(await this.request('/google/begin', signal, input));
    const url = new URL(result.authorizationUrl);
    const expectedScopes = ['openid', 'email', ...input.capabilities.map(capability => googleScopes[capability])].sort();
    const scopes = (url.searchParams.get('scope') ?? '').split(' ').sort();
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? 'https://invalid.invalid');
    const allowedParameters = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'access_type', 'prompt', 'include_granted_scopes'];
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.hash ||
      Array.from(url.searchParams.keys()).some(key => !allowedParameters.includes(key) || url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.get('include_granted_scopes') !== 'false' || url.searchParams.get('access_type') !== 'offline' || url.searchParams.get('prompt') !== 'consent select_account' ||
      redirect.origin !== this.pairing.endpoint || redirect.pathname !== '/oauth/callback' || redirect.search || redirect.hash || redirect.username || redirect.password ||
      url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') ||
      !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(url.searchParams.get('client_id') ?? '') ||
      JSON.stringify(scopes) !== JSON.stringify(expectedScopes)) throw Error('Worker authorization URL invalid');
    return result;
  }
  async revokeGoogleGrant(rawPurpose: GoogleGrantPurpose, signal: AbortSignal): Promise<RemoteGoogleGrantStatus> {
    const purpose = googleGrantPurposeSchema.parse(rawPurpose);
    const result = this.grantStatus(await this.request('/google/revoke', signal, { purpose }), purpose);
    if (result.state !== 'revoked') throw Error('Worker revocation outcome unverified');
    return result;
  }
  async submit(input: DelegationCommand): Promise<CommandReceipt> {
    this.signal.throwIfAborted();
    const command = delegationCommandSchema.parse(input);
    if (command.workspaceId !== this.pairing.workspaceId) throw new Error('Workspace command mismatch');
    const queued = this.repository.queueCommand(command);
    const receipt = this.repository.commandStatus(command.commandId) ?? queued;
    if (receipt.status !== 'pending' || !this.repository.canSubmitCommand(command.commandId)) return receipt;
    const attempt = this.transport.begin();
    this.transport.finish(attempt,attempt.cursor,false);
    try {
      const received = commandReceiptSchema.parse(await this.request('/commands', AbortSignal.timeout(15000), command));
      if (received.commandId !== command.commandId) throw new Error('Worker receipt mismatch');
      // HTTP acceptance never replaces transactional owner-applied event proof.
    } catch { /* Durable pending outbox survives an unavailable owner. No fallback. */ }
    return this.repository.commandStatus(command.commandId) ?? receipt;
  }
  async requestedDraft(previousDraft:RequestedFollowupDraft,draft:RequestedFollowupDraft,signal:AbortSignal) {
    const saved=requestedFollowupDraftSchema.parse(await this.request('/requested-followup/draft',signal,{workspaceId:this.pairing.workspaceId,previousDraft,draft}));
    const {updatedAt:_savedAt,...savedContent}=saved,{updatedAt:_draftAt,...draftContent}=draft;void _savedAt;void _draftAt;
    if(JSON.stringify(savedContent)!==JSON.stringify(draftContent))throw Error('requested_saved_draft_mismatch');
    return saved;
  }
  async requestedContext(raw:PrepareRequestedFollowup,signal:AbortSignal) {
    const input=prepareRequestedFollowupSchema.parse(raw);
    const proof=requestedOwnerContextSchema.parse(await this.request('/requested-followup/context',signal,{workspaceId:this.pairing.workspaceId,input}));
    if(proof.workspaceId!==this.pairing.workspaceId||proof.accountId!==input.accountId||proof.accountVersion!==input.expectedAccountVersion)throw Error('requested_context_identity');
    return proof;
  }
  async checkpoint(accountId:string,signal:AbortSignal,handoffId?:string) {const proof=ownerCheckpointSchema.parse(await this.request('/readiness',signal,{workspaceId:this.pairing.workspaceId,accountId,...(handoffId?{handoffId}:{})}));if(proof.workspaceId!==this.pairing.workspaceId||proof.accountId!==accountId||proof.handoffId!==handoffId)throw Error('checkpoint_identity_mismatch');return proof;}
  async configureResearch(raw:unknown,signal:AbortSignal) {const input=configureResearchSourceSchema.parse(raw);if(input.workspaceId!==this.pairing.workspaceId)throw Error('workspace_mismatch');return ownerResearchSourceSchema.parse(await this.request('/research/configure',signal,input));}
  async configurePolicy(raw:unknown,signal:AbortSignal) {const input=workerPolicyRequestSchema.parse(raw);if(input.workspaceId!==this.pairing.workspaceId)throw Error('workspace_mismatch');const result=workerPolicyReceiptSchema.parse(await this.request('/policies/configure',signal,input));if(result.requestId!==input.requestId||result.kind!==input.kind)throw Error('policy_receipt_mismatch');return result;}
  sync(signal: AbortSignal): Promise<SyncReport> {
    return synchronizeDelegation({ repository: this.repository, transport: this.transport,
      flushPending: async currentSignal => {
        for (const command of this.repository.pendingCommands()) {
          currentSignal.throwIfAborted();
          if (this.repository.canSubmitCommand(command.commandId)) {
            try {
              const receipt = commandReceiptSchema.parse(await this.request('/commands', currentSignal, command));
              if (receipt.commandId !== command.commandId) throw new Error('Worker receipt mismatch');
            } catch { currentSignal.throwIfAborted(); /* Refusal is not a durable rejection. Keep draining. */ }
          }
        }
      },
      reconcilePending: async currentSignal => {
        let attempted = false;
        for (const command of this.repository.pendingCommands()) {
          currentSignal.throwIfAborted();
          if (command.kind === 'delegate' || command.kind === 'complete-manual') continue;
          const authority = this.repository.authority(command.accountId);
          const version = this.repository.executionVersion(command.accountId);
          if (!authority || version === null || this.repository.canSubmitCommand(command.commandId)) continue;
          if (command.expectedAuthorityGeneration >= authority.generation && command.expectedVersion >= version) continue;
          attempted = true;
          try {
            const receipt = commandReceiptSchema.parse(await this.request('/commands/reconcile', currentSignal, command));
            if (receipt.commandId !== command.commandId) throw new Error('Worker receipt mismatch');
          } catch { currentSignal.throwIfAborted(); /* Only an applied owner event can settle this command. */ }
        }
        return attempted;
      },
      eventsAfter: async (cursor, currentSignal) => eventPageSchema.parse(await this.request(`/events${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, currentSignal)) }, AbortSignal.any([signal, this.signal]));
  }
}
