import { describe, expect, it, vi } from 'vitest';
import { validateNotarization, type NotarizationCommandResult } from '../../scripts/verifyPackage.ts';

const success: NotarizationCommandResult = { status: 0, signal: null, stdout: 'validated', stderr: '' };

describe('single-attempt stapled-ticket validation diagnostics', () => {
  it('uses exactly the existing readonly command, sanitized environment and finite bound once', () => {
    const execute = vi.fn(() => success);
    expect(validateNotarization('/private/example.app', execute)).toEqual({
      stapled: true, status: 0, signal: null, errorCode: null, classification: 'success',
      reason: { reason: 'unknown', reportedErrorCode: null },
      target: { requestedPathIsCanonical: null, canonicalTargetUnchanged: null, filesystemObjectUnchanged: null, directoryBefore: null, directoryAfter: null },
      stdout: { present: true, length: 9 }, stderr: { present: false, length: 0 },
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith('/usr/bin/xcrun', ['stapler', 'validate', '/private/example.app'], {
      encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
    });
  });

  it.each([
    { status: 65, signal: null, classification: 'nonzero_exit' },
    { status: 68, signal: null, classification: 'nonzero_exit' },
    { status: null, signal: null, classification: 'invalid_status' },
    { status: -1, signal: null, classification: 'invalid_status' },
    { status: 256, signal: null, classification: 'invalid_status' },
    { status: Number.NaN, signal: null, classification: 'invalid_status' },
    { status: 0, signal: 'SIGTERM', classification: 'signal' },
    { status: null, signal: 'SIGKILL', classification: 'signal' },
  ])('refuses $classification without Gatekeeper fallback or retries', ({ classification, ...result }) => {
    const execute = vi.fn(() => ({ ...success, ...result, stdout: 'accepted\nsource=Notarized Developer ID' }));
    const checked = validateNotarization('/private/example.app', execute);
    expect(checked.stapled).toBe(false);
    expect(checked.classification).toBe(classification);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['ENOENT', 'EACCES', 'ETIMEDOUT', 'ENOBUFS'])('refuses %s even with a zero exit', code => {
    const execute = vi.fn(() => ({ ...success, error: { code } }));
    const checked = validateNotarization('/private/example.app', execute);
    expect(checked.stapled).toBe(false);
    expect(checked.errorCode).toBe(code);
    expect(checked.classification).toBe(code === 'ETIMEDOUT' ? 'timeout' : 'spawn_error');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses thrown execution errors without retaining their message', () => {
    const execute = vi.fn(() => { throw new Error('private credential fragment'); });
    const checked = validateNotarization('/private/example.app', execute);
    expect(checked.stapled).toBe(false);
    expect(checked.classification).toBe('spawn_error');
    expect(checked.errorCode).toBe('OTHER');
    expect(JSON.stringify(checked)).not.toContain('credential');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('only reports finite allowlisted process facts and bounded output presence/length', () => {
    const secret = '/private/credential-fragment';
    const checked = validateNotarization(secret, () => ({
      status: 0, signal: secret, error: { code: secret }, stdout: secret.repeat(100), stderr: secret,
    }));
    expect(checked.stapled).toBe(false);
    expect(checked.signal).toBe('OTHER');
    expect(checked.errorCode).toBe('OTHER');
    expect(checked.stdout).toEqual({ present: true, length: secret.length * 100 });
    expect(checked.stderr).toEqual({ present: true, length: secret.length });
    expect(JSON.stringify(checked)).not.toContain(secret);
    expect(JSON.stringify(checked).length).toBeLessThan(600);
  });

  it('caps output length facts without retaining output', () => {
    const checked = validateNotarization('/private/example.app', () => ({
      ...success, stdout: 'x'.repeat(64 * 1024 * 1024 + 1),
    }));
    expect(checked.stdout).toEqual({ present: true, length: 64 * 1024 * 1024 });
    expect(JSON.stringify(checked).length).toBeLessThan(600);
  });
});
