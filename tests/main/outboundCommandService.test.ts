import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutboundCommandService } from '../../src/main/communications/outboundCommandService';
import {
  createPhoneHandoffLauncher, unavailableOutboundReadiness, unavailablePhoneHandoff,
} from '../../src/main/communications/phoneHandoffLauncher';
import type {
  OutboundDomainGate, OutboundDomainPort, OutboundReadinessPort, OutboundReadinessProof, OutboundReadinessResult, PhoneHandoffPort,
} from '../../src/main/communications/outboundPorts';
import { OutboundAuthorizationError } from '../../src/main/domain/support/domainErrors';
import {
  outboundCapabilitiesSchema, outboundReceiptSchema,
  type Capability, type HandoffResult, type OutboundReason, type OutboundReceipt, type OutboundRequest,
} from '../../src/shared/contracts/outboundContract';

const request: OutboundRequest = {
  commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', channel: 'call',
  personId: 'p', salesCycleId: 's', contactMethodId: 'c', expectedContactSnapshot: 'a'.repeat(64),
};
const otherRequest: OutboundRequest = { ...request, commandId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const mutation = { revision: 17, affectedPersonIds: ['p'], affectedSalesCycleIds: ['s'] };
const accepted: HandoffResult = { status: 'handoff_accepted', reasonCode: null };
const uncertain: HandoffResult = { status: 'unknown', reasonCode: 'handoff_uncertain' };
const available: Capability = { state: 'available', reasonCode: null };
const capabilityReasons: OutboundReason[] = ['channel_unavailable', 'phone_route_unverified', 'inbound_safety_unwired', 'workspace_inactive'];
function receipt(req: OutboundRequest, result: HandoffResult): OutboundReceipt {
  return { ...result, commandId: req.commandId, channel: req.channel, mutation };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => vi.advanceTimersByTimeAsync(0);
function readinessProof(personId = request.personId): OutboundReadinessProof {
  return Object.freeze({
    subject: Object.freeze({ kind: 'person' as const, id: personId }),
    registryRevision: 1,
    checkpoints: Object.freeze([]),
  });
}
function readyReply(personId = request.personId): Awaited<ReturnType<OutboundReadinessPort['check']>> {
  return { kind: 'ready', proof: readinessProof(personId) };
}

// Only injected in-memory command evidence. This fixture does not claim SQL,
// OS handler proof, consent checkpoint integration or live communications.
function fixture() {
  const events: string[] = [];
  const facts = new Map<string, { request: OutboundRequest; receipt: OutboundReceipt }>();
  function read(req: OutboundRequest) {
    const fact = facts.get(req.commandId);
    if (fact && JSON.stringify(fact.request) !== JSON.stringify(req)) {
      throw new Error('Outbound command conflicts with existing intent.');
    }
    return fact?.receipt ?? null;
  }
  function save(req: OutboundRequest, result: HandoffResult) {
    const output = receipt(req, result);
    facts.set(req.commandId, { request: { ...req }, receipt: output });
    return output;
  }
  const domain = {
    inspectOutboundCommand: vi.fn<OutboundDomainPort['inspectOutboundCommand']>((req) => {
      events.push('inspect'); return read(req);
    }),
    prepareOutboundDispatch: vi.fn<OutboundDomainPort['prepareOutboundDispatch']>((req) => {
      events.push('prepare');
      const previous = read(req);
      if (previous) return { kind: 'receipt', receipt: previous };
      save(req, uncertain);
      return { kind: 'dispatch', canonicalPhone: '+12025550123', mutation };
    }),
    recordOutboundResult: vi.fn<OutboundDomainPort['recordOutboundResult']>((req, result) => {
      events.push('result'); return save(req, result);
    }),
    recordOutboundRefusal: vi.fn<OutboundDomainPort['recordOutboundRefusal']>((req, reasonCode) => {
      events.push('refusal');
      return read(req) ?? save(req, { status: capabilityReasons.includes(reasonCode) ? 'unavailable' : 'refused', reasonCode });
    }),
  };
  const gate: OutboundDomainGate = { withDomain: async (operation) => operation(domain) };
  const phone = {
    inspectCapability: vi.fn<PhoneHandoffPort['inspectCapability']>(async () => { events.push('phone'); return available; }),
    dispatch: vi.fn<PhoneHandoffPort['dispatch']>(() => { events.push('dispatch'); return Promise.resolve(accepted); }),
  };
  const readiness = {
    getCapability: vi.fn<OutboundReadinessPort['getCapability']>(() => available),
    check: vi.fn<OutboundReadinessPort['check']>(async () => { events.push('readiness'); return readyReply(); }),
    assertCurrent: vi.fn<OutboundReadinessPort['assertCurrent']>(() => { events.push('assertCurrent'); }),
  };
  const service = createOutboundCommandService({ domain: gate, phone, readiness });
  return { events, facts, domain, gate, phone, readiness, service, save };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('strict intent, single flight and durable no-replay delegation', () => {
  it('orders lookup, both preflights, committed preparation, immediate dispatch and guarded persistence', async () => {
    const f = fixture();
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, accepted));
    expect(f.events).toEqual(['inspect', 'phone', 'readiness', 'assertCurrent', 'prepare', 'dispatch', 'result']);
    expect(f.phone.dispatch).toHaveBeenCalledWith('+12025550123');
    expect(f.domain.recordOutboundResult).toHaveBeenCalledWith(request, accepted);
    expect(f.readiness.check).toHaveBeenCalledWith('p', expect.any(AbortSignal));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ commandId: 'bad' }, { url: 'tel:+12025550123' }, { expectedContactSnapshot: 'bad' }, { ready: true }])('rejects invalid request %j before any port call', async (patch) => {
    const f = fixture();
    await expect(f.service.beginOutbound({ ...request, ...patch })).rejects.toThrow();
    expect(f.events).toEqual([]);
  });

  it('shares the exact Promise for concurrent same-ID same-intent calls and writes once', async () => {
    const f = fixture();
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const first = f.service.beginOutbound(request);
    const second = f.service.beginOutbound({ ...request });
    expect(second).toBe(first);
    await flush();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    pending.resolve(accepted);
    expect(await first).toEqual(await second);
    expect(f.domain.recordOutboundResult).toHaveBeenCalledTimes(1);
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, accepted));
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { channel: 'text' as const }, { personId: 'other' }, { salesCycleId: 'other' },
    { contactMethodId: 'other' }, { expectedContactSnapshot: 'b'.repeat(64) },
  ])('rejects same-ID conflicting %j with constant text and no competing mutation', async (patch) => {
    const f = fixture();
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const owner = f.service.beginOutbound(request);
    await flush();
    await expect(f.service.beginOutbound({ ...request, ...patch })).rejects.toThrow('Outbound command conflicts with existing intent.');
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
    expect(f.domain.inspectOutboundCommand).toHaveBeenCalledTimes(1);
    pending.resolve(accepted);
    await owner;
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
  });

  it('clones the validated intent before any await instead of following caller mutations', async () => {
    const f = fixture();
    const mutable = { ...request };
    const pending = f.service.beginOutbound(mutable);
    mutable.personId = 'changed';
    mutable.expectedContactSnapshot = 'b'.repeat(64);
    await pending;
    expect(f.domain.prepareOutboundDispatch).toHaveBeenCalledWith(request);
    expect(f.domain.recordOutboundResult).toHaveBeenCalledWith(request, accepted);
  });

  it('refuses another command as busy, shares its refusal Promise and never queues it for later', async () => {
    const f = fixture();
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const owner = f.service.beginOutbound(request);
    await flush();
    const busy = f.service.beginOutbound(otherRequest);
    expect(f.service.beginOutbound({ ...otherRequest })).toBe(busy);
    expect(await busy).toMatchObject({ status: 'refused', reasonCode: 'outbound_busy' });
    pending.resolve(accepted);
    await owner;
    await flush();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.prepareOutboundDispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.recordOutboundRefusal).toHaveBeenCalledTimes(1);
    expect(await f.service.beginOutbound(otherRequest)).toMatchObject({ reasonCode: 'outbound_busy' });
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([accepted, uncertain, { status: 'refused', reasonCode: 'stale_contact' } as HandoffResult])('returns persisted %j before any preflight or write', async (result) => {
    const f = fixture();
    f.save(request, result);
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, result));
    expect(f.events).toEqual(['inspect']);
  });

  it('lets a replay return while a different command is active', async () => {
    const f = fixture();
    f.save(otherRequest, uncertain);
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const owner = f.service.beginOutbound(request);
    await flush();
    expect(await f.service.beginOutbound(otherRequest)).toEqual(receipt(otherRequest, uncertain));
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    pending.resolve(accepted);
    await owner;
  });

  it('propagates persisted intent conflict without a refusal or competing terminal write', async () => {
    const f = fixture();
    f.save(request, uncertain);
    await expect(f.service.beginOutbound({ ...request, personId: 'other' })).rejects.toThrow('Outbound command conflicts with existing intent.');
    expect(f.events).toEqual(['inspect']);
  });

  it('returns a final preparation receipt without dispatching or persisting another result', async () => {
    const f = fixture();
    f.domain.prepareOutboundDispatch.mockReturnValue({ kind: 'receipt', receipt: receipt(request, { status: 'refused', reasonCode: 'stale_contact' }) });
    expect(await f.service.beginOutbound(request)).toMatchObject({ reasonCode: 'stale_contact' });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
  });

  it('never redials persisted unresolved intent in a replacement service', async () => {
    const f = fixture();
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const first = f.service.beginOutbound(request);
    await flush();
    f.service.dispose();
    expect(await first).toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted', mutation });
    const restarted = createOutboundCommandService({ domain: f.gate, phone: f.phone, readiness: f.readiness });
    expect(await restarted.beginOutbound(request)).toEqual(receipt(request, uncertain));
    pending.resolve(accepted);
    await flush();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
  });
});

describe('preflight refusals and final domain authority', () => {
  it.each(['text', 'email'] as const)('keeps %s unavailable with no readiness or Phone work', async (channel) => {
    const f = fixture();
    expect(await f.service.beginOutbound({ ...request, channel })).toMatchObject({ status: 'unavailable', reasonCode: 'channel_unavailable' });
    expect(f.events).toEqual(['inspect', 'refusal']);
    expect(f.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
  });

  it('persists verified-handler unavailability before any final preparation', async () => {
    const f = fixture();
    f.phone.inspectCapability.mockResolvedValue({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(f.readiness.check).not.toHaveBeenCalled();
    expect(f.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it.each(['inbound_safety_unwired', 'person_or_handle_opted_out', 'outside_recipient_window'] as const)('preserves typed blocked readiness %s', async (reasonCode) => {
    const f = fixture();
    f.readiness.check.mockResolvedValue({ kind: 'blocked', reasonCode });
    expect(await f.service.beginOutbound(request)).toMatchObject({ reasonCode });
    expect(f.domain.recordOutboundRefusal).toHaveBeenCalledWith(request, reasonCode);
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it.each(['phone', 'readiness'] as const)('times out %s preflight at the default 5000 ms, aborts readiness and ignores late completion', async (stage) => {
    const f = fixture();
    const pending = deferred<never>();
    if (stage === 'phone') f.phone.inspectCapability.mockReturnValue(pending.promise);
    else f.readiness.check.mockReturnValue(pending.promise);
    const result = f.service.beginOutbound(request);
    await flush();
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 'refused', reasonCode: 'operation_interrupted' });
    if (stage === 'readiness') expect(f.readiness.check.mock.calls[0][1].aborted).toBe(true);
    pending.reject(new Error('synthetic late failure'));
    await flush();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundRefusal).toHaveBeenCalledTimes(1);
  });

  it.each(['phone', 'readiness'] as const)('sanitizes a rejected %s preflight into a typed refusal', async (stage) => {
    const f = fixture();
    if (stage === 'phone') f.phone.inspectCapability.mockRejectedValue(new Error('synthetic private failure'));
    else f.readiness.check.mockRejectedValue(new Error('synthetic private failure'));
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'refused', reasonCode: 'operation_interrupted' });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('maps a known final authorization exception into a durable typed refusal', async () => {
    const f = fixture();
    f.domain.prepareOutboundDispatch.mockImplementation(() => { throw new OutboundAuthorizationError('federal_evidence_stale'); });
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'refused', reasonCode: 'federal_evidence_stale' });
    expect(f.domain.recordOutboundRefusal).toHaveBeenCalledWith(request, 'federal_evidence_stale');
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it.each(['inspect', 'prepare'] as const)('preserves safe domain ownership/ID errors at %s without inventing receipts', async (stage) => {
    const f = fixture();
    const error = new Error('Requested entity is not available.');
    if (stage === 'inspect') f.domain.inspectOutboundCommand.mockImplementation(() => { throw error; });
    else f.domain.prepareOutboundDispatch.mockImplementation(() => { throw error; });
    await expect(f.service.beginOutbound(request)).rejects.toBe(error);
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('always blocks with the production-unavailable bindings regardless of valid request fields', async () => {
    const f = fixture();
    const service = createOutboundCommandService({ domain: f.gate, phone: unavailablePhoneHandoff(), readiness: unavailableOutboundReadiness() });
    expect(await service.beginOutbound(request)).toMatchObject({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(f.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
    const readinessOnly = createOutboundCommandService({ domain: f.gate, phone: f.phone, readiness: unavailableOutboundReadiness() });
    expect(await readinessOnly.beginOutbound(otherRequest)).toMatchObject({ status: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'ready', reasonCode: 'person_or_handle_opted_out' },
    { kind: 'ready', arbitrary: true }, { kind: 'fresh' },
    { kind: 'blocked', reasonCode: null }, { kind: 'blocked', reasonCode: 'raw private detail' },
    null,
  ])('fails closed on a malformed readiness reply %j', async (reply) => {
    const f = fixture();
    f.readiness.check.mockResolvedValue(reply as Awaited<ReturnType<OutboundReadinessPort['check']>>);
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'refused', reasonCode: 'operation_interrupted' });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(f.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
  });

  it.each(['phone', 'readiness'] as const)('sanitizes a synchronous %s preflight throw before dispatch', async (stage) => {
    const f = fixture();
    const fail = () => { throw new Error('synthetic private failure'); };
    if (stage === 'phone') f.phone.inspectCapability.mockImplementation(fail);
    else f.readiness.check.mockImplementation(fail);
    expect(await f.service.beginOutbound(request)).toMatchObject({ reasonCode: 'operation_interrupted' });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('gives each preflight and dispatch wait its own bound instead of one combined deadline', async () => {
    const f = fixture();
    const route = deferred<Capability>();
    const ready = deferred<OutboundReadinessResult>();
    const dispatch = deferred<HandoffResult>();
    f.phone.inspectCapability.mockReturnValue(route.promise);
    f.readiness.check.mockReturnValue(ready.promise);
    f.phone.dispatch.mockReturnValue(dispatch.promise);
    const pending = f.service.beginOutbound(request);
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    route.resolve(available);
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    ready.resolve(readyReply());
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    dispatch.resolve(accepted);
    expect(await pending).toEqual(receipt(request, accepted));
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
  });

  it.each([
    { ...receipt(request, accepted), target: '+12025550123' }, receipt(otherRequest, accepted),
    { ...receipt(request, accepted), reasonCode: 'handoff_uncertain' },
  ])('rejects corrupt stored receipt %j without dispatch or a competing write', async (stored) => {
    const f = fixture();
    f.domain.inspectOutboundCommand.mockReturnValue(stored as OutboundReceipt);
    await expect(f.service.beginOutbound(request)).rejects.toThrow('Outbound command evidence is invalid.');
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
  });

  it.each(['inspect', 'prepare', 'readiness'] as const)('never writes a competing refusal for a %s command conflict', async (stage) => {
    const f = fixture();
    const conflict = receipt(request, { status: 'refused', reasonCode: 'command_conflict' });
    if (stage === 'inspect') f.domain.inspectOutboundCommand.mockReturnValue(conflict);
    else if (stage === 'prepare') f.domain.prepareOutboundDispatch.mockReturnValue({ kind: 'receipt', receipt: conflict });
    else f.readiness.check.mockResolvedValue({ kind: 'blocked', reasonCode: 'command_conflict' });
    await expect(f.service.beginOutbound(request)).rejects.toThrow('Outbound command conflicts with existing intent.');
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });
});

describe('dispatch ambiguity and committed preparation boundary', () => {
  it('dispatches before a microtask queued by preparation, then invalidation suppresses result persistence', async () => {
    const f = fixture();
    f.domain.prepareOutboundDispatch.mockImplementation(() => {
      f.events.push('prepare');
      queueMicrotask(() => { f.events.push('microtask'); f.service.invalidate('lock'); });
      return { kind: 'dispatch', canonicalPhone: '+12025550123', mutation };
    });
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted', mutation });
    expect(f.events.indexOf('dispatch')).toBe(f.events.indexOf('prepare') + 1);
    expect(f.events.indexOf('dispatch')).toBeLessThan(f.events.indexOf('microtask'));
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'] as const)('records unknown for a dispatch %s without retry or leaking the error', async (mode) => {
    const f = fixture();
    f.phone.dispatch.mockImplementation(() => {
      if (mode === 'throw') throw new Error('synthetic after possible dispatch');
      return Promise.reject(new Error('synthetic after possible dispatch'));
    });
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, uncertain));
    expect(f.domain.recordOutboundResult).toHaveBeenCalledWith(request, uncertain);
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)('times out dispatch as unknown and ignores a late %s with no late write/retry', async (mode) => {
    const f = fixture();
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const result = f.service.beginOutbound(request);
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toEqual(receipt(request, uncertain));
    if (mode === 'resolve') pending.resolve(accepted);
    else pending.reject(new Error('synthetic late dispatch failure'));
    await flush();
    expect(f.domain.recordOutboundResult).toHaveBeenCalledTimes(1);
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, uncertain));
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { status: 'delivered', reasonCode: null }, { status: 'handoff_accepted', reasonCode: 'handoff_uncertain' },
    { ...accepted, providerFrame: 'synthetic' }, null,
  ])('records malformed dispatch result %j as unknown', async (reply) => {
    const f = fixture();
    f.phone.dispatch.mockResolvedValue(reply as HandoffResult);
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, uncertain));
  });

  it.each(['throw', 'missing', 'wrong-identity'] as const)('uses the saved preparation mutation when result persistence is %s', async (mode) => {
    const f = fixture();
    f.domain.recordOutboundResult.mockImplementation(() => {
      if (mode === 'throw') throw new Error('synthetic write failure');
      return mode === 'missing' ? undefined : receipt(otherRequest, accepted);
    });
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, { status: 'unknown', reasonCode: 'result_not_persisted' }));
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, uncertain));
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
  });

  it('checks epoch again after committed preparation before dispatch', async () => {
    const f = fixture();
    f.domain.prepareOutboundDispatch.mockImplementation(() => {
      f.service.invalidate('shutdown');
      return { kind: 'dispatch', canonicalPhone: '+12025550123', mutation };
    });
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted', mutation });
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
  });

  it('does not promote an unknown handoff using an inconsistent persistence acknowledgement', async () => {
    const f = fixture();
    f.phone.dispatch.mockResolvedValue(uncertain);
    f.domain.recordOutboundResult.mockReturnValue(receipt(request, accepted));
    expect(await f.service.beginOutbound(request)).toEqual(receipt(request, { status: 'unknown', reasonCode: 'result_not_persisted' }));
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
  });

  it('attaches dispatch rejection handling before a domain gate delays returning its callback result', async () => {
    const f = fixture();
    const hold = deferred<void>();
    let calls = 0;
    const gate: OutboundDomainGate = { withDomain: async (callback) => {
      const result = callback(f.domain);
      if (++calls === 2) await hold.promise;
      return result;
    } };
    f.phone.dispatch.mockRejectedValue(new Error('synthetic immediate rejection'));
    const service = createOutboundCommandService({ domain: gate, phone: f.phone, readiness: f.readiness });
    const pending = service.beginOutbound(request);
    await flush();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
    hold.resolve();
    expect(await pending).toEqual(receipt(request, uncertain));
  });
});

describe('epoch invalidation, suspension and immutable workspace binding', () => {
  it.each(['wake', 'lock', 'restore', 'shutdown', 'dispose'] as const)('cancels %s during readiness with no dispatch or late writes', async (reason) => {
    const f = fixture();
    const ready = deferred<OutboundReadinessResult>();
    f.readiness.check.mockReturnValue(ready.promise);
    const result = f.service.beginOutbound(request);
    const rejected = expect(result).rejects.toThrow('Outbound operation interrupted.');
    await flush();
    const signal = f.readiness.check.mock.calls[0][1];
    if (reason === 'dispose') f.service.dispose(); else f.service.invalidate(reason);
    expect(signal.aborted).toBe(true);
    await rejected;
    ready.resolve(readyReply());
    await flush();
    expect(f.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['wake', 'lock', 'restore', 'shutdown', 'dispose'] as const)('cancels %s after dispatch without writing the late reply', async (reason) => {
    const f = fixture();
    const pending = deferred<HandoffResult>();
    f.phone.dispatch.mockReturnValue(pending.promise);
    const result = f.service.beginOutbound(request);
    await flush();
    if (reason === 'dispose') f.service.dispose(); else f.service.invalidate(reason);
    expect(await result).toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted', mutation });
    pending.reject(new Error('synthetic late reply'));
    await flush();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
  });

  it('wake requires new preflights and never resumes the interrupted intent automatically', async () => {
    const f = fixture();
    const ready = deferred<OutboundReadinessResult>();
    f.readiness.check.mockReturnValueOnce(ready.promise);
    const old = f.service.beginOutbound(request);
    const rejected = expect(old).rejects.toThrow('Outbound operation interrupted.');
    await flush();
    f.service.invalidate('wake');
    await rejected;
    expect(await f.service.beginOutbound(otherRequest)).toMatchObject({ status: 'handoff_accepted' });
    ready.resolve(readyReply());
    await flush();
    expect(f.phone.inspectCapability).toHaveBeenCalledTimes(2);
    expect(f.readiness.check).toHaveBeenCalledTimes(2);
    expect(f.domain.prepareOutboundDispatch).toHaveBeenCalledTimes(1);
    expect(f.domain.prepareOutboundDispatch).toHaveBeenCalledWith(otherRequest);
  });

  it('lock rejects new work without domain access until explicit unlock, which reruns preflights', async () => {
    const f = fixture();
    f.service.invalidate('lock');
    f.service.invalidate('wake');
    await expect(f.service.beginOutbound(request)).rejects.toThrow('Outbound workspace is inactive.');
    expect(f.events).toEqual([]);
    f.service.resumeAfterUnlock();
    expect(await f.service.beginOutbound(request)).toMatchObject({ status: 'handoff_accepted' });
    expect(f.phone.inspectCapability).toHaveBeenCalledTimes(1);
    expect(f.readiness.check).toHaveBeenCalledTimes(1);
  });

  it.each(['restore', 'shutdown', 'dispose'] as const)('%s permanently closes even after unlock and wake', async (reason) => {
    const f = fixture();
    if (reason === 'dispose') f.service.dispose(); else f.service.invalidate(reason);
    f.service.resumeAfterUnlock();
    f.service.invalidate('wake');
    await expect(f.service.beginOutbound(request)).rejects.toThrow('Outbound workspace is inactive.');
    expect(f.events).toEqual([]);
  });

  it.each([1, 2, 3])('guards deferred domain callback %s against old-epoch reads/writes', async (heldCall) => {
    const f = fixture();
    const hold = deferred<void>();
    let calls = 0;
    const gate: OutboundDomainGate = { withDomain: async (operation) => {
      if (++calls === heldCall) await hold.promise;
      return operation(f.domain);
    } };
    const service = createOutboundCommandService({ domain: gate, phone: f.phone, readiness: f.readiness });
    const pending = service.beginOutbound(request);
    const observation = heldCall === 3
      ? expect(pending).resolves.toMatchObject({ status: 'unknown', reasonCode: 'result_not_persisted' })
      : expect(pending).rejects.toThrow('Outbound operation interrupted.');
    await flush();
    service.invalidate('restore');
    await observation;
    hold.resolve();
    await flush();
    if (heldCall === 1) expect(f.domain.inspectOutboundCommand).not.toHaveBeenCalled();
    if (heldCall <= 2) expect(f.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundResult).not.toHaveBeenCalled();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(heldCall === 3 ? 1 : 0);
  });

  it('captures the original gate rather than following a mutable input to a replacement workspace', async () => {
    const f = fixture();
    const replacement = fixture();
    const input = { domain: f.gate, phone: f.phone, readiness: f.readiness };
    const service = createOutboundCommandService(input);
    input.domain = replacement.gate;
    await service.beginOutbound(request);
    expect(f.domain.prepareOutboundDispatch).toHaveBeenCalledTimes(1);
    expect(replacement.domain.prepareOutboundDispatch).not.toHaveBeenCalled();
  });

  it('cancels an outstanding handler inspection without allowing its late success to dispatch', async () => {
    const f = fixture();
    const inspect = deferred<Capability>();
    f.phone.inspectCapability.mockReturnValue(inspect.promise);
    const pending = f.service.beginOutbound(request);
    const rejected = expect(pending).rejects.toThrow('Outbound operation interrupted.');
    await flush();
    f.service.invalidate('wake');
    await rejected;
    inspect.resolve(available);
    await flush();
    expect(f.readiness.check).not.toHaveBeenCalled();
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('guards a queued preflight-refusal write after invalidation', async () => {
    const f = fixture();
    const hold = deferred<void>();
    let calls = 0;
    const gate: OutboundDomainGate = { withDomain: async (callback) => {
      if (++calls === 2) await hold.promise;
      return callback(f.domain);
    } };
    f.readiness.check.mockResolvedValue({ kind: 'blocked', reasonCode: 'inbound_safety_unwired' });
    const service = createOutboundCommandService({ domain: gate, phone: f.phone, readiness: f.readiness });
    const pending = service.beginOutbound(request);
    const rejected = expect(pending).rejects.toThrow('Outbound operation interrupted.');
    await flush();
    service.invalidate('shutdown');
    await rejected;
    hold.resolve();
    await flush();
    expect(f.domain.recordOutboundRefusal).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('cannot clear a new epoch flight when old cancellation settles', async () => {
    const f = fixture();
    const oldReady = deferred<OutboundReadinessResult>();
    const newDispatch = deferred<HandoffResult>();
    f.readiness.check.mockReturnValueOnce(oldReady.promise);
    f.phone.dispatch.mockReturnValue(newDispatch.promise);
    const old = f.service.beginOutbound(request);
    const rejected = expect(old).rejects.toThrow('Outbound operation interrupted.');
    await flush();
    f.service.invalidate('wake');
    const current = f.service.beginOutbound(otherRequest);
    await rejected;
    await flush();
    const third = { ...request, commandId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    expect(await f.service.beginOutbound(third)).toMatchObject({ reasonCode: 'outbound_busy' });
    newDispatch.resolve(accepted);
    await current;
    oldReady.resolve(readyReply());
    await flush();
    expect(f.phone.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('status-only capability queries', () => {
  it('never calls readiness.check or domain ports and keeps unrelated integrations unavailable', async () => {
    const f = fixture();
    const capabilities = await f.service.getCapabilities();
    expect(outboundCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(capabilities.phoneHandoff).toEqual(available);
    expect(capabilities.localDrafts).toBe(true);
    for (const key of ['callObservation', 'recording', 'messagesSend', 'gmailSend', 'managedAudioImport', 'appleTranscriptExtraction'] as const) {
      expect(capabilities[key]).toEqual({ state: 'unavailable', reasonCode: 'not_integrated' });
    }
    expect(f.readiness.check).not.toHaveBeenCalled();
    expect(f.domain.inspectOutboundCommand).not.toHaveBeenCalled();
    expect(f.phone.dispatch).not.toHaveBeenCalled();
  });

  it('combines inbound safety status with Phone status without implying live readiness', async () => {
    const f = fixture();
    f.readiness.getCapability.mockReturnValue({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect((await f.service.getCapabilities()).phoneHandoff).toEqual({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect(f.readiness.check).not.toHaveBeenCalled();
  });

  it('bounds inspection and discards a late success rather than publishing stale availability', async () => {
    const f = fixture();
    const pending = deferred<Capability>();
    f.phone.inspectCapability.mockReturnValue(pending.promise);
    const query = f.service.getCapabilities();
    await flush();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await query;
    expect(result.phoneHandoff).toEqual({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
    pending.resolve(available);
    await flush();
    expect(result.phoneHandoff.state).toBe('unavailable');
    expect(f.readiness.check).not.toHaveBeenCalled();
  });

  it('cancels an outstanding query on lock and does not probe while inactive', async () => {
    const f = fixture();
    const pending = deferred<Capability>();
    f.phone.inspectCapability.mockReturnValue(pending.promise);
    const query = f.service.getCapabilities();
    await flush();
    f.service.invalidate('lock');
    expect((await query).phoneHandoff).toEqual({ state: 'unavailable', reasonCode: 'workspace_inactive' });
    expect((await f.service.getCapabilities()).phoneHandoff.reasonCode).toBe('workspace_inactive');
    expect(f.phone.inspectCapability).toHaveBeenCalledTimes(1);
    pending.reject(new Error('synthetic late status failure'));
    await flush();
  });

  it('honors a shorter injected wait bound', async () => {
    const f = fixture();
    f.phone.inspectCapability.mockReturnValue(new Promise(() => undefined));
    const service = createOutboundCommandService({ domain: f.gate, phone: f.phone, readiness: f.readiness, timeoutMs: 25 });
    const result = service.beginOutbound(request);
    await flush();
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toMatchObject({ reasonCode: 'operation_interrupted' });
  });

  it.each([0, -1, NaN, Infinity])('rejects unsafe timeout configuration %s', (timeoutMs) => {
    const f = fixture();
    expect(() => createOutboundCommandService({ domain: f.gate, phone: f.phone, readiness: f.readiness, timeoutMs })).toThrow('Outbound timeout must be finite and positive.');
    expect(f.events).toEqual([]);
  });

  it.each(['phone', 'readiness'] as const)('keeps status unavailable when %s status throws', async (source) => {
    const f = fixture();
    if (source === 'phone') f.phone.inspectCapability.mockRejectedValue(new Error('synthetic'));
    else f.readiness.getCapability.mockImplementation(() => { throw new Error('synthetic'); });
    expect((await f.service.getCapabilities()).phoneHandoff).toEqual({
      state: 'unavailable', reasonCode: source === 'phone' ? 'phone_route_unverified' : 'inbound_safety_unwired',
    });
    expect(f.readiness.check).not.toHaveBeenCalled();
  });

  it('assembles the real launcher and service against an injected driver without any live OS work', async () => {
    const f = fixture();
    const openTelUri = vi.fn<(uri: string) => Promise<void>>(async () => undefined);
    const phone = createPhoneHandoffLauncher({
      driver: { inspectVerifiedHandler: async () => 'phone_continuity_verified', isVerifiedHandlerCurrent: () => true, openTelUri },
      isExcludedNumber: () => false,
    });
    const service = createOutboundCommandService({ domain: f.gate, phone, readiness: f.readiness });
    const result = await service.beginOutbound(request);
    expect(outboundReceiptSchema.parse(result)).toEqual(receipt(request, accepted));
    expect(openTelUri).toHaveBeenCalledTimes(1);
    expect(openTelUri).toHaveBeenCalledWith('tel:+12025550123');
  });
});
