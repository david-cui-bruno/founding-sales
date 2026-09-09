import { describe, expect, it } from 'vitest';
import { createNativePhoneLaunchDriver, resolveVerifiedNativePhoneHelper, type NativePhoneProcessRequest } from '../../src/main/communications/phoneLaunchDriver';
import { createPhoneHandoffLauncher } from '../../src/main/communications/phoneHandoffLauncher';

const available = (fingerprint = 'fixture-proof') => JSON.stringify({ version: 1, status: 'available', fingerprint });
function fixture() {
  const requests: NativePhoneProcessRequest[] = [];
  let asyncReply = available();
  let syncReply = available();
  let proof: string | null = 'fixture-proof';
  let failure = false;
  const driver = createNativePhoneLaunchDriver({
    verifiedHelperPath: '/fictional/Fixture.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
    setupFingerprint: () => proof,
    platform: 'darwin',
    runAsync: (request) => {
      requests.push(request);
      return failure ? Promise.reject(new Error('sensitive stderr')) : Promise.resolve(asyncReply);
    },
    runSync: (request) => { requests.push(request); if (failure) throw new Error('timeout'); return syncReply; },
  });
  return { driver, requests, setAsync: (value: string) => { asyncReply = value; }, setSync: (value: string) => { syncReply = value; }, setProof: (value: string | null) => { proof = value; }, fail: () => { failure = true; } };
}

describe('native phone launch driver with fictional process boundaries', () => {
  it('reuses packaged path and same-team helper verification with fictional signatures', async () => {
    const seen: string[] = [];
    const input = {
      path: { isPackaged: true, resourcesPath: '/fictional/Fixture.app/Contents/Resources', developmentExecutablePath: '/never/dev', environment: { CALLIE_APPLE_BRIDGE_PATH: '/never/override' } },
      signature: { parentExecutablePath: '/fictional/parent', expectedIdentifier: 'fixture.helper', run: async (path: string) => { seen.push(path); return { signed: true as const, identifier: 'fixture.helper', teamIdentifier: 'FIXTURE' }; } },
    };
    const path = await resolveVerifiedNativePhoneHelper(input);
    expect(path).toBe('/fictional/Fixture.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge');
    expect(seen).toEqual([path, '/fictional/parent']);
    await expect(resolveVerifiedNativePhoneHelper({ ...input, path: { ...input.path, isPackaged: false } })).rejects.toThrow();
    await expect(resolveVerifiedNativePhoneHelper({ ...input, signature: { ...input.signature, run: async () => ({ signed: false }) } })).rejects.toThrow();
    await expect(resolveVerifiedNativePhoneHelper({ ...input, signature: { ...input.signature, run: async () => ({ signed: true, identifier: 'wrong', teamIdentifier: 'FIXTURE' }) } })).rejects.toThrow();
    await expect(resolveVerifiedNativePhoneHelper({ ...input, signature: { ...input.signature, run: async (p) => ({ signed: true, identifier: 'fixture.helper', teamIdentifier: p === path ? 'FIXTURE' : 'OTHER' }) } })).rejects.toThrow();
  });
  it('never launches at construction or inspection and refuses changed currency', async () => {
    const f = fixture();
    expect(f.requests).toEqual([]);
    const launcher = createPhoneHandoffLauncher({ driver: f.driver, isExcludedNumber: () => false });
    expect(await launcher.inspectCapability()).toEqual({ state: 'available', reasonCode: null });
    f.setSync(available('changed'));
    expect(f.driver.isVerifiedHandlerCurrent()).toBe(false);
    expect((await launcher.dispatch('+12025550123')).status).toBe('unavailable');
    expect(f.requests.every((r) => r.args[0] === '--phone-route-inspect')).toBe(true);
  });

  it('requires stored explicit setup proof, including at dispatch', async () => {
    const f = fixture();
    f.setProof(null);
    expect(await f.driver.inspectVerifiedHandler()).toBe('unavailable');
    f.setProof('fixture-proof');
    expect(await f.driver.inspectVerifiedHandler()).toBe('phone_continuity_verified');
    f.setProof('replaced');
    expect(f.driver.isVerifiedHandlerCurrent()).toBe(false);
    await expect(f.driver.openTelUri('tel:+12025550123')).rejects.toThrow('Phone route unavailable');
    expect(f.requests.filter((r) => r.args[0] === '--phone-route-open')).toHaveLength(0);
  });

  it('starts open synchronously with target only on stdin and consumes authorization', async () => {
    const f = fixture();
    await f.driver.inspectVerifiedHandler();
    expect(f.driver.isVerifiedHandlerCurrent()).toBe(true);
    const pending = f.driver.openTelUri('tel:+12025550123');
    const open = f.requests.at(-1)!;
    expect(open.args).toEqual(['--phone-route-open']);
    expect(JSON.parse(open.stdin!)).toEqual({ version: 1, target: '+12025550123', expectedFingerprint: 'fixture-proof' });
    await expect(pending).resolves.toBeUndefined();
    await expect(f.driver.openTelUri('tel:+12025550123')).rejects.toThrow();
    expect(f.requests.filter((r) => r.args[0] === '--phone-route-open')).toHaveLength(1);
  });

  it.each(['{', available() + available(), JSON.stringify({ version: 1, status: 'available', fingerprint: 'fixture-proof', path: '/private' }), JSON.stringify({ version: 2, status: 'available', fingerprint: 'fixture-proof' }), JSON.stringify({ version: 1, status: 'available', fingerprint: '' }), JSON.stringify({ version: 1, status: 'available', fingerprint: 'fixture-proof\n' }), ' '.repeat(4097)])('fails closed on malformed or oversized reply %#', async (reply) => {
    const f = fixture();
    await f.driver.inspectVerifiedHandler();
    f.setAsync(reply);
    expect(await f.driver.inspectVerifiedHandler()).toBe('unavailable');
    expect(f.driver.isVerifiedHandlerCurrent()).toBe(false);
  });

  it('bounds synchronous inspection and clears proof after timeout or cancellation', async () => {
    const f = fixture();
    await f.driver.inspectVerifiedHandler();
    expect(f.driver.isVerifiedHandlerCurrent()).toBe(true);
    expect(f.requests.at(-1)).toMatchObject({ timeoutMs: 1000, maxOutputBytes: 4096 });
    f.fail();
    expect(f.driver.isVerifiedHandlerCurrent()).toBe(false);
    expect(await f.driver.inspectVerifiedHandler()).toBe('unavailable');
  });

  it('maps rejected launch to unknown without retry or leaking diagnostics', async () => {
    const f = fixture();
    const launcher = createPhoneHandoffLauncher({ driver: f.driver, isExcludedNumber: () => false });
    await launcher.inspectCapability();
    f.setAsync(JSON.stringify({ version: 1, status: 'unavailable', reason: 'cancelled' }));
    expect(await launcher.dispatch('+12025550123')).toEqual({ status: 'unknown', reasonCode: 'handoff_uncertain' });
    expect((await launcher.dispatch('+12025550123')).status).toBe('unavailable');
    expect(f.requests.filter((r) => r.args[0] === '--phone-route-open')).toHaveLength(1);
  });

  it.each(['tel:+12025550123\n', 'tel:+02025550123', 'tel:+12025550123?x=1', '+12025550123', 'tel:+123'])('rejects noncanonical target %j', async (uri) => {
    const f = fixture();
    await f.driver.inspectVerifiedHandler();
    f.driver.isVerifiedHandlerCurrent();
    await expect(f.driver.openTelUri(uri)).rejects.toThrow();
    expect(f.requests.filter((r) => r.args[0] === '--phone-route-open')).toHaveLength(0);
  });

  it('rejects matching but noncanonical saved and native fingerprints', async () => {
    const f = fixture();
    f.setProof('fixture-proof\n');
    f.setAsync(available('fixture-proof\n'));
    expect(await f.driver.inspectVerifiedHandler()).toBe('unavailable');
  });

  it('rejects duplicate reply keys rather than accepting the last value', async () => {
    const f = fixture();
    f.setAsync('{"version":1,"status":"unavailable","status":"available","fingerprint":"fixture-proof"}');
    expect(await f.driver.inspectVerifiedHandler()).toBe('unavailable');
  });

  it('cannot rearm from an inspection that finishes after a currency check', async () => {
    let complete!: (value: string) => void;
    const driver = createNativePhoneLaunchDriver({ verifiedHelperPath: '/fictional/helper', setupFingerprint: () => 'fixture-proof', platform: 'darwin', runAsync: () => new Promise((resolve) => { complete = resolve; }), runSync: () => available() });
    const pending = driver.inspectVerifiedHandler();
    expect(driver.isVerifiedHandlerCurrent()).toBe(false);
    complete(available());
    expect(await pending).toBe('unavailable');
    expect(driver.isVerifiedHandlerCurrent()).toBe(false);
  });

  it('does no process work on unsupported platforms', async () => {
    const driver = createNativePhoneLaunchDriver({ verifiedHelperPath: '/fictional/helper', setupFingerprint: () => 'proof', platform: 'linux', runAsync: () => { throw new Error('must not run'); }, runSync: () => { throw new Error('must not run'); } });
    expect(await driver.inspectVerifiedHandler()).toBe('unavailable');
    expect(driver.isVerifiedHandlerCurrent()).toBe(false);
    await expect(driver.openTelUri('tel:+12025550123')).rejects.toThrow();
  });
});
