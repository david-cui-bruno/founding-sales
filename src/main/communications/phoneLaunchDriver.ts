import { execFile, spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { resolveAppleBridgeExecutable, type AppleBridgeExecutableOptions } from '../appleBridge/helperPath';
import { verifyHelperSignature, type VerifyHelperSignatureOptions } from '../appleBridge/verifyHelperSignature';
import type { PhoneLaunchDriver } from './phoneHandoffLauncher';

export interface NativePhoneProcessRequest {
  executable: string;
  args: readonly string[];
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface NativePhoneDriverOptions {
  /** Use resolveVerifiedNativePhoneHelper at the explicit composition boundary. */
  verifiedHelperPath: string;
  setupFingerprint(): string | null;
  runAsync?: (request: NativePhoneProcessRequest) => Promise<string>;
  runSync?: (request: NativePhoneProcessRequest) => string;
  platform?: NodeJS.Platform;
}

/** Reuses the packaged path and strict same-team signature policy. Never called by inspection. */
export async function resolveVerifiedNativePhoneHelper(input: {
  path: AppleBridgeExecutableOptions;
  signature: Omit<VerifyHelperSignatureOptions, 'executablePath' | 'isPackaged' | 'allowUnsignedDevelopment'>;
}): Promise<string> {
  if (!input.path.isPackaged) throw new Error('Packaged phone helper required');
  const executablePath = resolveAppleBridgeExecutable(input.path);
  await verifyHelperSignature({ ...input.signature, executablePath, isPackaged: true, allowUnsignedDevelopment: false });
  return executablePath;
}

const failure = () => new Error('Phone route unavailable');
const environment = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' };
const runAsync: NonNullable<NativePhoneDriverOptions['runAsync']> = (request) => new Promise((resolve, reject) => {
  // execFile starts the child immediately, before this function returns its promise.
  const child = execFile(request.executable, [...request.args], {
    encoding: 'utf8', timeout: request.timeoutMs, maxBuffer: request.maxOutputBytes,
    env: environment, killSignal: 'SIGKILL',
  }, (error, stdout) => { if (error) reject(failure()); else resolve(stdout); });
  child.stdin?.on('error', () => reject(failure()));
  child.stdin?.end(request.stdin ?? '');
});
const runSync: NonNullable<NativePhoneDriverOptions['runSync']> = (request) => {
  const result = spawnSync(request.executable, [...request.args], {
    encoding: 'utf8', input: '', timeout: request.timeoutMs, maxBuffer: request.maxOutputBytes,
    env: environment, killSignal: 'SIGKILL',
  });
  if (result.error || result.status !== 0 || result.signal) throw failure();
  return result.stdout;
};

function fingerprint(raw: string): string | null {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const reply = value as Record<string, unknown>;
    // Replies are flat three-field objects. Counting key tokens also rejects duplicates
    // (including escaped spellings) that JSON.parse would otherwise silently replace.
    if ([...raw.matchAll(/"(?:\\.|[^"\\])*"\s*:/g)].length !== 3) return null;
    const keys = Object.keys(reply).sort().join(',');
    if (reply.version !== 1) return null;
    if (reply.status === 'unavailable' && keys === 'reason,status,version' && typeof reply.reason === 'string') return null;
    if (reply.status !== 'available' || keys !== 'fingerprint,status,version'
      || typeof reply.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(reply.fingerprint)) return null;
    return reply.fingerprint;
  } catch { return null; }
}

export type NativePhoneCandidateOptions = Pick<NativePhoneDriverOptions, 'verifiedHelperPath' | 'runAsync' | 'platform'>;

function processRequest(executable: string, mode: 'inspect' | 'open', stdin?: string): NativePhoneProcessRequest {
  return {
    executable, args: [`--phone-route-${mode}`],
    timeoutMs: mode === 'inspect' ? 1000 : 5000, maxOutputBytes: 4096,
    ...(stdin === undefined ? {} : { stdin }),
  };
}

/** Read-only first-time setup seam. null means unavailable, never authorization.
 * The caller supplies the same verified packaged helper path used by dispatch.
 * This function has no proof store or driver state and can only run inspect.
 */
export async function inspectNativePhoneRouteCandidate(input: NativePhoneCandidateOptions): Promise<string | null> {
  try {
    if ((input.platform ?? process.platform) !== 'darwin' || !isAbsolute(input.verifiedHelperPath)) return null;
    return fingerprint(await (input.runAsync ?? runAsync)(processRequest(input.verifiedHelperPath, 'inspect')));
  } catch { return null; }
}

export function createNativePhoneLaunchDriver(input: NativePhoneDriverOptions): PhoneLaunchDriver {
  let inspected: string | null = null;
  let authorized: string | null = null;
  let generation = 0;
  const supported = (input.platform ?? process.platform) === 'darwin' && isAbsolute(input.verifiedHelperPath);
  const request = (mode: 'inspect' | 'open', stdin?: string) => processRequest(input.verifiedHelperPath, mode, stdin);
  const clear = () => { inspected = null; authorized = null; };
  return {
    async inspectVerifiedHandler() {
      const current = ++generation;
      clear();
      try {
        const proof = input.setupFingerprint();
        if (!supported || !proof) return 'unavailable';
        const native = await inspectNativePhoneRouteCandidate(input);
        if (current !== generation) return 'unavailable';
        if (native === null || native !== proof || input.setupFingerprint() !== proof) return 'unavailable';
        inspected = native;
        return 'phone_continuity_verified';
      } catch { if (current === generation) clear(); return 'unavailable'; }
    },
    isVerifiedHandlerCurrent() {
      ++generation;
      authorized = null;
      try {
        if (!supported || !inspected || input.setupFingerprint() !== inspected) { clear(); return false; }
        const native = fingerprint((input.runSync ?? runSync)(request('inspect')));
        if (native !== inspected || input.setupFingerprint() !== inspected) { clear(); return false; }
        authorized = native;
        return true;
      } catch { clear(); return false; }
    },
    openTelUri(uri) {
      ++generation;
      const expected = authorized;
      clear();
      try {
        if (!supported || !expected || input.setupFingerprint() !== expected
          || typeof uri !== 'string' || uri.match(/^tel:\+[1-9][0-9]{7,14}$/)?.[0] !== uri) return Promise.reject(failure());
        const pending = (input.runAsync ?? runAsync)(request('open', JSON.stringify({
          version: 1, target: uri.slice(4), expectedFingerprint: expected,
        })));
        return pending.then((raw) => { if (fingerprint(raw) !== expected) throw failure(); }, () => { throw failure(); });
      } catch { return Promise.reject(failure()); }
    },
  };
}
