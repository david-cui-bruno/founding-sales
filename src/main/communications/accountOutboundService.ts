import { z } from 'zod';
import { accountCallReportSchema, accountOutboundRequestSchema, type AccountCallReport, type AccountCallReportReceipt,
  type AccountOutboundReceipt, type AccountOutboundRequest } from '../../shared/contracts/accountOutboundContract';
import { capabilitySchema, handoffResultSchema, type HandoffResult } from '../../shared/contracts/outboundContract';
import type { AccountOutreach } from '../domain/accounts/accountOutreach';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import type { InboundReadiness } from './inboundReadiness';
import type { PhoneHandoffPort } from './outboundPorts';

export type AccountOutboundDomainPort = Pick<AccountOutreach, 'inspect' | 'ownerGeneration' | 'recordRefusal' | 'reserve' | 'recordDispatch' | 'reportCallOutcome'>;
export interface AccountOutboundDomainGate { withDomain<T>(operation: (domain: AccountOutboundDomainPort) => T): Promise<T>; }
export interface AccountOutboundService {
  begin(request: AccountOutboundRequest): Promise<AccountOutboundReceipt>;
  reportCallOutcome(report: AccountCallReport): Promise<AccountCallReportReceipt>;
  invalidate(): void;
  dispose(): void;
}
const uncertain: HandoffResult = { status: 'unknown', reasonCode: 'handoff_uncertain' };
const readinessSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('blocked'), reasonCode: z.string().min(1).max(200) }).strict()]);

/** No startup/default phone binding. The gate must refer to one immutable runtime.
 * Invalidate synchronously before closing/locking/restoring that runtime. */
export function createAccountOutboundService(input: {
  domain: AccountOutboundDomainGate; phone: PhoneHandoffPort; readiness: Pick<InboundReadiness, 'checkSubject'>; timeoutMs?: number;
}): AccountOutboundService {
  const { domain: domainGate, phone, readiness } = input;
  const timeoutMs = input.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Account outbound timeout invalid');
  const controller = new AbortController(); let disposed = false; let busy = false;
  const flights = new Map<string, { fingerprint: string; promise: Promise<AccountOutboundReceipt> }>();
  const current = (signal: AbortSignal) => { if (disposed || signal.aborted) throw new Error('Account outbound interrupted'); };
  function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); action(); };
      const abort = () => finish(() => reject(new Error('Account outbound interrupted')));
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
      if (signal.aborted) abort();
    });
  }
  function withDomain<T>(signal: AbortSignal, operation: (domain: AccountOutboundDomainPort) => T): Promise<T> {
    current(signal);
    let active = true;
    return wait(domainGate.withDomain(domain => {
      current(signal);
      if (!active) throw new Error('Account outbound interrupted');
      return operation(domain);
    }), signal).finally(() => { active = false; });
  }
  function dispatchReserved(target: string, signal: AbortSignal): Promise<HandoffResult> {
    // Starts the injected phone boundary in this stack, immediately after reserve committed.
    try { return wait(phone.dispatch(target), signal).then(value => {
      const parsed = handoffResultSchema.safeParse(value); return parsed.success ? parsed.data as HandoffResult : uncertain;
    }, () => uncertain); } catch { return Promise.resolve(uncertain); }
  }
  async function run(request: AccountOutboundRequest, signal: AbortSignal, occupied: boolean): Promise<AccountOutboundReceipt> {
    let committed: AccountOutboundReceipt | null = null;
    try {
      const previous = await withDomain(signal, domain => domain.inspect(request)); if (previous) return previous;
      const refuse = (reason: string) => withDomain(signal, domain => domain.recordRefusal(request, reason));
      if (request.channel === 'email') return refuse('email_execution_unavailable');
      if (occupied) return refuse('outbound_busy');
      const owner = await withDomain(signal, domain => domain.ownerGeneration(request));
      const checkController = new AbortController();
      try {
        const capability = capabilitySchema.parse(await wait(phone.inspectCapability(), signal));
        current(signal);
        if (capability.state !== 'available') return refuse(capability.reasonCode ?? 'phone_route_unverified');
        const ready = readinessSchema.parse(await wait(readiness.checkSubject({ kind: 'account', id: request.accountId }, AbortSignal.any([signal, checkController.signal])), signal));
        current(signal);
        if (ready.kind === 'blocked') return refuse(ready.reasonCode);
      } catch { current(signal); return refuse('operation_interrupted'); }
      finally { checkController.abort(); }
      const prepared = await withDomain(signal, domain => {
        const reservation = domain.reserve(request, owner);
        if (reservation.kind === 'receipt') return { receipt: reservation.receipt, pending: null };
        committed = reservation.receipt;
        current(signal);
        // Do not await or leave this callback between the committed transaction and invocation.
        return { receipt: reservation.receipt, pending: dispatchReserved(reservation.canonicalTarget, signal) };
      });
      if (!prepared.pending) return prepared.receipt;
      const result = await prepared.pending;
      // A closed runtime must never be revisited for late persistence. The durable intent stays unknown.
      if (signal.aborted || disposed) return prepared.receipt;
      return await withDomain(signal, domain => domain.recordDispatch(request, result));
    } catch (error) {
      if (committed) return committed;
      throw error;
    }
  }
  return {
    begin(value) {
      let request: AccountOutboundRequest;
      try { request = Object.freeze(accountOutboundRequestSchema.parse(value)); current(controller.signal); } catch (error) { return Promise.reject(error); }
      const fingerprint = accountFingerprint(request); const prior = flights.get(request.commandId);
      if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.reject(new Error('Account outbound command conflict'));
      const occupied = busy; if (!occupied) busy = true;
      const promise = Promise.resolve().then(() => run(request, controller.signal, occupied)).finally(() => { flights.delete(request.commandId); if (!occupied) busy = false; });
      flights.set(request.commandId, { fingerprint, promise }); return promise;
    },
    reportCallOutcome(value) {
      try { const report = accountCallReportSchema.parse(value) as AccountCallReport;
        return withDomain(controller.signal, domain => domain.reportCallOutcome(report));
      } catch (error) { return Promise.reject(error); }
    },
    invalidate() { controller.abort(); },
    dispose() { disposed = true; controller.abort(); },
  };
}
