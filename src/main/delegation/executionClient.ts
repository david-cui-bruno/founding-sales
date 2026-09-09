import {requestedFollowupDraftSchema,type RequestedFollowupDraft,prepareRequestedFollowupSchema,type PrepareRequestedFollowup} from '../../shared/contracts/requestedFollowupContract';
import {workerPolicyRequestSchema,workerPolicyReceiptSchema} from '../../shared/contracts/workerPolicyContract';
import { requestedOwnerContextSchema, ownerCheckpointSchema, configureResearchSourceSchema, ownerResearchSourceSchema } from '../../shared/contracts/ownerCommandContract';
import { z } from 'zod';
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
