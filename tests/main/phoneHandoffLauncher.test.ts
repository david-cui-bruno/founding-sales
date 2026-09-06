import { describe, expect, it, vi } from 'vitest';
import {
  createPhoneHandoffLauncher, unavailableOutboundReadiness, unavailablePhoneHandoff,
  type PhoneLaunchDriver,
} from '../../src/main/communications/phoneHandoffLauncher';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const driver = {
    inspectVerifiedHandler: vi.fn<PhoneLaunchDriver['inspectVerifiedHandler']>(async () => 'phone_continuity_verified'),
    isVerifiedHandlerCurrent: vi.fn(() => true),
    openTelUri: vi.fn<PhoneLaunchDriver['openTelUri']>(async () => undefined),
  };
  const isExcludedNumber = vi.fn((phone: string) => phone === '+12025550199');
  const port = createPhoneHandoffLauncher({ driver, isExcludedNumber });
  return { port, driver, isExcludedNumber };
}

describe('fixed Phone handoff with synthetic injected drivers only', () => {
  it('does not inspect or launch anything at construction or during capability reads', async () => {
    const f = fixture();
    expect(f.driver.inspectVerifiedHandler).not.toHaveBeenCalled();
    expect(await f.port.inspectCapability()).toEqual({ state: 'available', reasonCode: null });
    expect(f.driver.inspectVerifiedHandler).toHaveBeenCalledTimes(1);
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
    expect(f.isExcludedNumber).not.toHaveBeenCalled();
  });

  it.each([
    '', 'tel:+12025550123', 'mailto:fixture@example.invalid', 'file:///fixture',
    'tel:+12025550123?x=1', '+12025550123?x=1', '+12025550123#x',
    '+12025550123\n', '+12025550123\r', '+12025550123\r\n', '+12025550123\0',
    '+1202\n5550123', '+12025550123%0a', '%2B12025550123',
    '++12025550123', '+1202+5550123', '+１２０２５５５０１２３', '+١٢٠٢٥٥٥٠١٢٣',
    '+12025550123,1', '+12025550123;1', '+12025550123p1', '+12025550123w1',
    '+12025550123x123', '+12025550123;ext=123', '+1 (202) 555-0123',
    ' +12025550123', '+12025550123 ', '12025550123', '+012345678',
    '+1234567', '+1234567890123456', '911', '112', '+911', '*86', '12345',
    '+12025550123@fixture.invalid', '+12025550123/fixture', '+12025550123&x=1',
  ])('refuses unsafe or noncanonical target %j without any driver call', async (target) => {
    const f = fixture();
    await f.port.inspectCapability();
    expect(await f.port.dispatch(target)).toEqual({ status: 'refused', reasonCode: 'invalid_target' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
    expect(f.driver.isVerifiedHandlerCurrent).not.toHaveBeenCalled();
  });

  it('refuses the explicit synthetic voicemail exclusion', async () => {
    const f = fixture();
    await f.port.inspectCapability();
    expect(await f.port.dispatch('+12025550199')).toEqual({ status: 'refused', reasonCode: 'invalid_target' });
    expect(f.isExcludedNumber).toHaveBeenCalledWith('+12025550199');
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it.each(['+12345678', '+12025550123', '+123456789012345'])('constructs only the fixed tel URI for canonical %s', async (phone) => {
    const f = fixture();
    await f.port.inspectCapability();
    const pending = f.port.dispatch(phone);
    // The external boundary must be invoked before dispatch returns its Promise.
    expect(f.driver.openTelUri).toHaveBeenCalledTimes(1);
    expect(f.driver.openTelUri).toHaveBeenCalledWith(`tel:${phone}`);
    expect(f.driver.isVerifiedHandlerCurrent).toHaveBeenCalledTimes(1);
    expect(await pending).toEqual({ status: 'handoff_accepted', reasonCode: null });
  });

  it('requires a successful preflight and consumes it only once', async () => {
    const f = fixture();
    expect(await f.port.dispatch('+12025550123')).toEqual({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
    await f.port.inspectCapability();
    const first = f.port.dispatch('+12025550123');
    const second = f.port.dispatch('+12025550123');
    expect(await first).toMatchObject({ status: 'handoff_accepted' });
    expect(await second).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).toHaveBeenCalledTimes(1);
    await f.port.inspectCapability();
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'handoff_accepted' });
    expect(f.driver.openTelUri).toHaveBeenCalledTimes(2);
  });

  it('does not retain a preflight after rejecting a target', async () => {
    const f = fixture();
    await f.port.inspectCapability();
    await f.port.dispatch('tel:+12025550123');
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it('rejects a changed handler even after successful inspection, with no reusable preflight', async () => {
    const f = fixture();
    await f.port.inspectCapability();
    f.driver.isVerifiedHandlerCurrent.mockReturnValue(false);
    expect(await f.port.dispatch('+12025550123')).toEqual({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    f.driver.isVerifiedHandlerCurrent.mockReturnValue(true);
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
    expect(f.driver.inspectVerifiedHandler).toHaveBeenCalledTimes(1);
  });

  it.each(['unavailable', 'wrong_handler'])('cannot arm using handler result %s', async (handler) => {
    const f = fixture();
    f.driver.inspectVerifiedHandler.mockResolvedValue(handler as 'unavailable');
    expect(await f.port.inspectCapability()).toEqual({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it.each(['throw', 'reject'])('fails closed when handler inspection can %s', async (mode) => {
    const f = fixture();
    await f.port.inspectCapability();
    f.driver.inspectVerifiedHandler.mockImplementation(() => {
      if (mode === 'throw') throw new Error('synthetic inspection failure');
      return Promise.reject(new Error('synthetic inspection failure'));
    });
    expect(await f.port.inspectCapability()).toEqual({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it('fails closed if synchronous handler currency cannot be established', async () => {
    const f = fixture();
    await f.port.inspectCapability();
    f.driver.isVerifiedHandlerCurrent.mockImplementation(() => { throw new Error('synthetic'); });
    expect(await f.port.dispatch('+12025550123')).toEqual({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it('fails closed if the exclusion policy cannot decide', async () => {
    const f = fixture();
    await f.port.inspectCapability();
    f.isExcludedNumber.mockImplementation(() => { throw new Error('synthetic'); });
    expect(await f.port.dispatch('+12025550123')).toEqual({ status: 'refused', reasonCode: 'invalid_target' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it('does not let a stale concurrent inspection arm over a newer unverified decision', async () => {
    const f = fixture();
    const old = deferred<'phone_continuity_verified'>();
    f.driver.inspectVerifiedHandler.mockReturnValueOnce(old.promise).mockResolvedValueOnce('unavailable');
    const older = f.port.inspectCapability();
    await f.port.inspectCapability();
    old.resolve('phone_continuity_verified');
    expect(await older).toMatchObject({ state: 'unavailable' });
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it('does not arm from an inspection completing after a failed dispatch attempt', async () => {
    const f = fixture();
    const late = deferred<'phone_continuity_verified'>();
    f.driver.inspectVerifiedHandler.mockReturnValue(late.promise);
    const inspection = f.port.inspectCapability();
    await f.port.dispatch('+12025550123');
    late.resolve('phone_continuity_verified');
    await inspection;
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).not.toHaveBeenCalled();
  });

  it('treats a synchronous launch throw as ambiguous, never a proved non-call', async () => {
    const f = fixture();
    f.driver.openTelUri.mockImplementation(() => { throw new Error('synthetic after possible dispatch'); });
    await f.port.inspectCapability();
    expect(await f.port.dispatch('+12025550123')).toEqual({ status: 'unknown', reasonCode: 'handoff_uncertain' });
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).toHaveBeenCalledTimes(1);
  });

  it('observes late launch rejection as unknown without any retry or raw error', async () => {
    const f = fixture();
    const launch = deferred<void>();
    f.driver.openTelUri.mockReturnValue(launch.promise);
    await f.port.inspectCapability();
    const pending = f.port.dispatch('+12025550123');
    expect(f.driver.openTelUri).toHaveBeenCalledTimes(1);
    launch.reject(new Error('synthetic private provider detail'));
    expect(await pending).toEqual({ status: 'unknown', reasonCode: 'handoff_uncertain' });
    expect(await f.port.dispatch('+12025550123')).toMatchObject({ status: 'unavailable' });
    expect(f.driver.openTelUri).toHaveBeenCalledTimes(1);
  });
});

describe('production bindings are unconditionally unavailable, not live readiness', () => {
  it('cannot inspect or dispatch through the unavailable Phone binding', async () => {
    const phone = unavailablePhoneHandoff();
    expect(await phone.inspectCapability()).toEqual({ state: 'unavailable', reasonCode: 'phone_route_unverified' });
    for (const target of ['+12025550123', 'tel:+12025550123', '']) {
      expect(await phone.dispatch(target)).toEqual({ status: 'unavailable', reasonCode: 'phone_route_unverified' });
    }
  });

  it('does not infer inbound safety from a Person ID, signal or repeated check', async () => {
    const readiness = unavailableOutboundReadiness();
    const controller = new AbortController();
    expect(readiness.getCapability()).toEqual({ state: 'unavailable', reasonCode: 'inbound_safety_unwired' });
    expect(await readiness.check('synthetic-person', controller.signal)).toEqual({ kind: 'blocked', reasonCode: 'inbound_safety_unwired' });
    controller.abort();
    expect(await readiness.check('ready', controller.signal)).toEqual({ kind: 'blocked', reasonCode: 'inbound_safety_unwired' });
  });
});
