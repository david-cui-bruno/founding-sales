import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { researchSetupApproveInputSchema, researchSetupSetStateInputSchema, researchSetupRequestSchema, researchSetupStatusSchema, type ResearchSetupApi, type ResearchSetupBlocker, type ResearchSetupReceipt, type ResearchSetupRemoteStatus, type ResearchSetupRequest } from '../../shared/contracts/researchSetupContract';
import { matchResearchSetupReceipt, type ResearchSetupIdentity, type ResearchSetupRequestStore, type StoredResearchSetupRequest } from './researchSetupRequestStore';
import type { createResearchSetupTransport } from './executionClient';

type Transport = ReturnType<typeof createResearchSetupTransport>;
const unavailable = (): never => { throw Error('research_setup_unavailable'); };
const capture = <T>(schema: z.ZodType<T>, raw: unknown): T => { const parsed = schema.safeParse(raw); if (!parsed.success) return unavailable(); return parsed.data; };
const metadata = (pending: StoredResearchSetupRequest | null) => pending ? { requestId: pending.request.requestId, kind: pending.request.kind, createdAt: pending.createdAt, state: 'unknown' as const } : null;

/** One local single-flight spans status, persistence, transport and receipt fsync.
 * Cross-process exclusion belongs to the immutable journal, never this flag.
 */
export function createResearchSetupService(input: {
  identity: ResearchSetupIdentity | null;
  store?: ResearchSetupRequestStore;
  clock: { now(): string };
  withOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  transport(): Transport;
}): ResearchSetupApi {
  const identity = input.identity ? Object.freeze({ ...input.identity }) : null;
  let busy = false;
  const exclusive = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (busy) return unavailable();
    busy = true;
    try { return await input.withOperation(operation); }
    catch { return unavailable(); }
    finally { busy = false; }
  };
  const send = async (pending: StoredResearchSetupRequest, cancel: boolean, signal: AbortSignal): Promise<ResearchSetupReceipt> => {
    if (!identity || !input.store) return unavailable();
    const check = () => signal.throwIfAborted();
    await input.store.ensureDurable(identity, pending, check); check();
    const receipt = matchResearchSetupReceipt(pending.request, await input.transport().write(cancel ? { version: 1, kind: 'cancel', originalRequest: pending.request } : pending.request, signal)); check();
    await input.store.acknowledge(identity, pending, receipt, check); check();
    return receipt;
  };
  const create = (request: ResearchSetupRequest, signal: AbortSignal) => {
    if (!identity || !input.store) return unavailable();
    return input.store.prepare(identity, request, input.clock.now(), () => signal.throwIfAborted()).then(pending => { signal.throwIfAborted(); return send(pending, false, signal); });
  };
  const resume = (cancel: boolean) => exclusive(async signal => {
    if (!identity || !input.store) return unavailable();
    const pending = await input.store.load(identity); signal.throwIfAborted();
    if (!pending) return unavailable();
    return send(pending, cancel, signal);
  });
  return {
    status: () => exclusive(async signal => {
      if (!identity) return { remote: null, pending: null, blockers: ['needs_pairing'] };
      if (!input.store) return { remote: null, pending: null, blockers: ['local_journal_unavailable'] };
      let pending: StoredResearchSetupRequest | null;
      try { pending = await input.store.load(identity); }
      catch { signal.throwIfAborted(); return { remote: null, pending: null, blockers: ['local_journal_unavailable'] }; }
      signal.throwIfAborted();
      let remote: ResearchSetupRemoteStatus | null = null;
      const blockers: ResearchSetupBlocker[] = [];
      try {
        remote = await input.transport().status({ workspaceId: identity.workspaceId, pairingId: identity.pairingId, ...(pending ? { requestId: pending.request.requestId } : {}) }, signal);
        signal.throwIfAborted();
        if (remote.receipt) {
          if (!pending) return unavailable();
          const receipt = matchResearchSetupReceipt(pending.request, remote.receipt);
          try { await input.store.acknowledge(identity, pending, receipt, () => signal.throwIfAborted()); }
          catch { signal.throwIfAborted(); blockers.push('local_journal_unavailable'); }
        }
      } catch { signal.throwIfAborted(); remote = null; blockers.push('unavailable'); }
      // Re-read after HTTP: another legitimate process may have advanced the head.
      try { pending = await input.store.load(identity); }
      catch { blockers.push('local_journal_unavailable'); }
      signal.throwIfAborted();
      return researchSetupStatusSchema.parse({ remote, pending: metadata(pending), blockers: [...new Set([...blockers, ...(remote?.blockers ?? []), ...(pending ? ['local_pending' as const] : [])])] });
    }),
    approve: async raw => {
      const proposal = capture(researchSetupApproveInputSchema, raw);
      if (!identity) return unavailable();
      // UUID, identity and parsed input are captured before the lease can await.
      const request = capture(researchSetupRequestSchema, { version: 1, kind: 'approve', requestId: randomUUID(), workspaceId: identity.workspaceId, pairingId: identity.pairingId, input: proposal });
      return exclusive(signal => create(request, signal));
    },
    setState: async raw => {
      const proposal = capture(researchSetupSetStateInputSchema, raw);
      if (!identity) return unavailable();
      const request = capture(researchSetupRequestSchema, { version: 1, kind: 'set-state', requestId: randomUUID(), workspaceId: identity.workspaceId, pairingId: identity.pairingId, input: proposal });
      return exclusive(signal => create(request, signal));
    },
    retry: () => resume(false),
    cancelPending: () => resume(true),
  };
}

/** Bounds lease lifetime even when a filesystem/HTTP test adapter ignores abort.
 * The continuation holds no DB handle and checks the abort before every effect.
 */
export async function awaitResearchSetupOperation<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(Error('research_setup_unavailable')); signal.addEventListener('abort', abort, { once: true }); });
  try { const result = await Promise.race([operation(), cancelled]); signal.throwIfAborted(); return result; }
  finally { signal.removeEventListener('abort', abort); }
}
