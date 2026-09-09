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
  constructor(options: { repository: DelegationRepository; transport: SqlDelegationTransport; pairing: ExecutionPairing; fetch?: typeof globalThis.fetch }) {
    const pairing = z.strictObject({ endpoint: z.string().url(), workspaceId: z.string().min(1), credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(options.pairing);
    const endpoint = new URL(pairing.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Invalid worker endpoint');
    this.pairing = Object.freeze({ ...pairing, endpoint: endpoint.origin });
    this.http = options.fetch ?? globalThis.fetch;
    this.repository = options.repository;
    this.transport = options.transport;
  }
  private async request(path: string, signal: AbortSignal, command?: DelegationCommand): Promise<unknown> {
    signal.throwIfAborted();
    const response = await this.http(`${this.pairing.endpoint}${path}`, { method: command ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${this.pairing.credential}`, 'content-type': 'application/json' }, redirect: 'error', cache: 'no-store',
      signal, ...(command ? { body: JSON.stringify(command) } : {}) });
    signal.throwIfAborted();
    if (!response.ok) throw new Error('Worker request unavailable');
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('Worker response too large');
    return JSON.parse(text) as unknown;
  }
  async submit(input: DelegationCommand): Promise<CommandReceipt> {
    const command = delegationCommandSchema.parse(input);
    if (command.workspaceId !== this.pairing.workspaceId) throw new Error('Workspace command mismatch');
    const queued = this.repository.queueCommand(command);
    const receipt = this.repository.commandStatus(command.commandId) ?? queued;
    if (receipt.status !== 'pending' || !this.repository.canSubmitCommand(command.commandId)) return receipt;
    try {
      const received = commandReceiptSchema.parse(await this.request('/commands', AbortSignal.timeout(15000), command));
      if (received.commandId !== command.commandId) throw new Error('Worker receipt mismatch');
      // HTTP acceptance never replaces transactional owner-applied event proof.
    } catch { /* Durable pending outbox survives an unavailable owner. No fallback. */ }
    return this.repository.commandStatus(command.commandId) ?? receipt;
  }
  sync(signal: AbortSignal): Promise<SyncReport> {
    return synchronizeDelegation({ repository: this.repository, transport: this.transport,
      flushPending: async currentSignal => {
        for (const command of this.repository.pendingCommands()) {
          currentSignal.throwIfAborted();
          if (this.repository.canSubmitCommand(command.commandId)) {
            const receipt = commandReceiptSchema.parse(await this.request('/commands', currentSignal, command));
            if (receipt.commandId !== command.commandId) throw new Error('Worker receipt mismatch');
          }
        }
      },
      eventsAfter: async (cursor, currentSignal) => eventPageSchema.parse(await this.request(`/events${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, currentSignal)) }, signal);
  }
}
