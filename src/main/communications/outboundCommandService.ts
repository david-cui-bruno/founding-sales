import { z } from 'zod';
import { mutationReceiptSchema, type MutationReceipt } from '../../shared/contracts/commonContract';
import {
  capabilitySchema, handoffResultSchema, outboundReceiptSchema, outboundRequestSchema,
  type Capability, type CapabilityReason, type HandoffResult, type OutboundCapabilities,
  type OutboundReason, type OutboundReceipt, type OutboundRequest,
} from '../../shared/contracts/outboundContract';
import { OutboundAuthorizationError } from '../domain/support/domainErrors';
import { outboundIntentFingerprint } from './contactSnapshot';
import type {
  OutboundCommandServiceApi, OutboundDomainGate, OutboundDomainPort, OutboundReadinessPort, OutboundReadinessProof,
  PhoneHandoffPort, Preparation,
} from './outboundPorts';

const uncertain: HandoffResult = Object.freeze({ status: 'unknown', reasonCode: 'handoff_uncertain' });
const notIntegrated: Capability = Object.freeze({ state: 'unavailable', reasonCode: 'not_integrated' });
const conflict = () => new Error('Outbound command conflicts with existing intent.');
const interrupted = () => new Error('Outbound operation interrupted.');
const inactive = () => new Error('Outbound workspace is inactive.');

type Operation = { epoch: number; signal: AbortSignal; mutation?: MutationReceipt };
type Flight = { fingerprint: string; promise: Promise<OutboundReceipt> };
const readinessReplySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ready'),
    proof: z.object({
      subject: z.object({ kind: z.enum(['person', 'account']), id: z.string().min(1) }).strict(),
      registryRevision: z.number().int().nonnegative(),
      checkpoints: z.array(z.object({ adapterId: z.string().min(1), revision: z.string() }).strict()),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal('blocked'), reasonCode: z.string() }).strict(),
]);
type PreflightResult = Readonly<
  { kind: 'ready'; proof: OutboundReadinessProof } | { kind: 'blocked'; reasonCode: OutboundReason }
>;

// Observe every rejection, including after timeout/cancellation. This function
// only settles a waiter. It never schedules a retry or a late persistence action.
function waitFor<T>(pending: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      settle();
    };
    const cancel = () => finish(() => reject(interrupted()));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    else if (timeoutMs !== undefined) timer = setTimeout(cancel, timeoutMs);
    Promise.resolve(pending).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function parseCapability(value: unknown): Capability {
  const parsed = capabilitySchema.parse(value);
  return { state: parsed.state, reasonCode: parsed.reasonCode };
}
function validateReceipt(request: OutboundRequest, value: unknown): OutboundReceipt {
  const parsed = outboundReceiptSchema.safeParse(value);
  if (!parsed.success || parsed.data.commandId !== request.commandId || parsed.data.channel !== request.channel) {
    throw new Error('Outbound command evidence is invalid.');
  }
  if (parsed.data.reasonCode === 'command_conflict') throw conflict();
  // Explicit required nullable property preserves the locked type with the
  // repository's non-strict-null Zod inference, without weakening validation.
  return { ...parsed.data, reasonCode: parsed.data.reasonCode };
}
function capabilities(phoneHandoff: Capability): OutboundCapabilities {
  return {
    phoneHandoff, callObservation: notIntegrated, recording: notIntegrated,
    messagesSend: notIntegrated, gmailSend: notIntegrated, managedAudioImport: notIntegrated,
    appleTranscriptExtraction: notIntegrated, localDrafts: true,
  };
}
function unavailable(reasonCode: CapabilityReason): Capability {
  return { state: 'unavailable', reasonCode };
}
function hasRequestedPersonProof(proof: OutboundReadinessProof, request: OutboundRequest): boolean {
  return proof.subject.kind === 'person' && proof.subject.id === request.personId;
}

export function createOutboundCommandService(input: {
  domain: OutboundDomainGate; phone: PhoneHandoffPort;
  readiness: OutboundReadinessPort; timeoutMs?: number;
}): OutboundCommandServiceApi {
  // This gate must be bound to one immutable runtime, never a runtime selector.
  // Later lifecycle wiring must invalidate synchronously before that runtime closes.
  const { domain, phone, readiness } = input;
  const timeoutMs = input.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Outbound timeout must be finite and positive.');
  let epoch = 0;
  let epochController = new AbortController();
  let closed = false;
  let suspended = false;
  let active: Flight | null = null;
  const flights = new Map<string, Flight>();

  function operation(): Operation {
    return { epoch, signal: epochController.signal };
  }
  function assertCurrentEpoch(current: Operation): void {
    if (current.epoch !== epoch || current.signal.aborted || closed || suspended) throw interrupted();
  }
  async function withDomain<T>(current: Operation, callback: (value: OutboundDomainPort) => T): Promise<T> {
    assertCurrentEpoch(current);
    const result = await waitFor(domain.withDomain((value) => {
      assertCurrentEpoch(current);
      return callback(value);
    }), current.signal);
    assertCurrentEpoch(current);
    return result;
  }
  function refuse(current: Operation, request: OutboundRequest, reason: OutboundReason): Promise<OutboundReceipt> {
    // A conflict must never append a competing fact to the existing command.
    if (reason === 'command_conflict') throw conflict();
    return withDomain(current, (value) => validateReceipt(request, value.recordOutboundRefusal(request, reason)));
  }

  async function preflight(current: Operation, request: OutboundRequest): Promise<PreflightResult> {
    const checkController = new AbortController();
    const signal = AbortSignal.any([current.signal, checkController.signal]);
    try {
      assertCurrentEpoch(current);
      const route = parseCapability(await waitFor(phone.inspectCapability(), current.signal, timeoutMs));
      assertCurrentEpoch(current);
      if (route.state !== 'available') {
        return { kind: 'blocked', reasonCode: route.reasonCode === 'not_integrated' ? 'phone_route_unverified' : route.reasonCode };
      }
      const readinessResult = readinessReplySchema.parse(
        await waitFor(readiness.check(request.personId, signal), current.signal, timeoutMs),
      );
      assertCurrentEpoch(current);
      if (readinessResult.kind === 'ready') return { kind: 'ready', proof: readinessResult.proof };
      const blocked = handoffResultSchema.parse({
        status: 'refused', reasonCode: readinessResult.kind === 'blocked' ? readinessResult.reasonCode : undefined,
      });
      return { kind: 'blocked', reasonCode: blocked.reasonCode };
    } catch {
      assertCurrentEpoch(current); // Cancellation cannot write even a refusal.
      return { kind: 'blocked', reasonCode: 'operation_interrupted' };
    } finally {
      checkController.abort();
    }
  }

  function dispatch(current: Operation, canonicalPhone: string): Promise<HandoffResult> {
    try {
      // Invoke before returning. Attach observation handlers in this same stack,
      // even if the outer domain gate delays returning its callback's result.
      const pending = phone.dispatch(canonicalPhone);
      return waitFor(pending, current.signal, timeoutMs).then((reply): HandoffResult => {
        const parsed = handoffResultSchema.safeParse(reply);
        return parsed.success ? { status: parsed.data.status, reasonCode: parsed.data.reasonCode } : uncertain;
      }, () => uncertain);
    } catch {
      // The port may have started the handoff before throwing synchronously.
      return Promise.resolve(uncertain);
    }
  }

  async function run(current: Operation, request: OutboundRequest, busy: boolean): Promise<OutboundReceipt> {
    try {
      const previous = await withDomain(current, (value) => value.inspectOutboundCommand(request));
      if (previous !== null) return validateReceipt(request, previous);
      if (busy) return await refuse(current, request, 'outbound_busy');
      if (request.channel !== 'call') return await refuse(current, request, 'channel_unavailable');
      const readinessResult = await preflight(current, request);
      assertCurrentEpoch(current);
      if (readinessResult.kind === 'blocked') return await refuse(current, request, readinessResult.reasonCode);

      const started = await withDomain(current, (value) => {
        let prepared: Preparation;
        try {
          if (!hasRequestedPersonProof(readinessResult.proof, request)) {
            return { kind: 'receipt' as const, receipt: validateReceipt(request, value.recordOutboundRefusal(request, 'inbound_safety_unwired')) };
          }
          try { readiness.assertCurrent(readinessResult.proof); }
          catch { return { kind: 'receipt' as const, receipt: validateReceipt(request, value.recordOutboundRefusal(request, 'inbound_safety_unwired')) }; }
          prepared = value.prepareOutboundDispatch(request);
        } catch (error) {
          if (!(error instanceof OutboundAuthorizationError)) throw error;
          assertCurrentEpoch(current);
          return { kind: 'receipt' as const, receipt: validateReceipt(request, value.recordOutboundRefusal(request, error.reasonCode)) };
        }
        if (prepared.kind === 'receipt') return prepared;
        current.mutation = mutationReceiptSchema.parse(prepared.mutation);
        assertCurrentEpoch(current);
        // Preparation has committed. No await/task queue/async handler check may
        // occur between this return from preparation and the dispatch invocation.
        return { kind: 'started' as const, pending: dispatch(current, prepared.canonicalPhone) };
      });
      if (started.kind === 'receipt') return validateReceipt(request, started.receipt);
      const result = await started.pending;
      assertCurrentEpoch(current);
      return await withDomain(current, (value) => {
        const recorded = validateReceipt(request, value.recordOutboundResult(request, result));
        if (recorded.status !== result.status || recorded.reasonCode !== result.reasonCode) {
          throw new Error('Outbound result acknowledgement is inconsistent.');
        }
        return recorded;
      });
    } catch (error) {
      if (!current.mutation) throw error;
      // A committed intent may have dispatched. Never invent a new mutation or
      // write after invalidation. Durable unresolved intent blocks future replay.
      return {
        commandId: request.commandId, channel: request.channel, mutation: current.mutation,
        status: 'unknown', reasonCode: 'result_not_persisted',
      };
    }
  }

  function invalidate(reason: 'wake' | 'lock' | 'restore' | 'shutdown'): void {
    ++epoch;
    if (reason === 'lock') suspended = true;
    if (reason === 'restore' || reason === 'shutdown') closed = true;
    epochController.abort();
    epochController = new AbortController();
    active = null;
    flights.clear();
  }

  return {
    // Intentionally not async: duplicate active intent returns the exact Promise.
    beginOutbound(raw): Promise<OutboundReceipt> {
      try {
        const request = Object.freeze(outboundRequestSchema.parse(raw));
        if (closed || suspended) throw inactive();
        const fingerprint = outboundIntentFingerprint(request);
        const existing = flights.get(request.commandId);
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw conflict();
          return existing.promise;
        }
        const current = operation();
        const busy = active !== null;
        // Register before any injected port can reenter this service.
        const flight: Flight = {
          fingerprint,
          promise: Promise.resolve().then(() => run(current, request, busy)).finally(() => {
            if (flights.get(request.commandId) === flight) flights.delete(request.commandId);
            if (active === flight) active = null;
          }),
        };
        flights.set(request.commandId, flight);
        if (!busy) active = flight;
        return flight.promise;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async getCapabilities(): Promise<OutboundCapabilities> {
      if (closed || suspended) return capabilities(unavailable('workspace_inactive'));
      const current = operation();
      let inbound: Capability;
      try { inbound = parseCapability(readiness.getCapability()); }
      catch { inbound = unavailable('inbound_safety_unwired'); }
      let route: Capability;
      try {
        assertCurrentEpoch(current);
        route = parseCapability(await waitFor(phone.inspectCapability(), current.signal, timeoutMs));
      } catch {
        route = unavailable('phone_route_unverified');
      }
      if (current.epoch !== epoch || current.signal.aborted || closed || suspended) {
        return capabilities(unavailable('workspace_inactive'));
      }
      return capabilities(inbound.state === 'unavailable' ? inbound : route);
    },
    invalidate,
    resumeAfterUnlock(): void {
      if (!closed) suspended = false;
    },
    dispose(): void { invalidate('shutdown'); },
  };
}
