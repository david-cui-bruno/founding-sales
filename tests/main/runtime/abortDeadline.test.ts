import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RemoteOperationTimeoutError,
  runWithAbortDeadline,
} from '../../../src/main/runtime/abortDeadline';

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('runWithAbortDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rejects a never-resolving operation with the exact timeout error contract', async () => {
    let operationSignal: AbortSignal | undefined;
    const result = runWithAbortDeadline({
      code: 'S3_LIST_TIMEOUT',
      timeoutMs: 30_000,
      operation: async (signal) => {
        operationSignal = signal;
        return new Promise<string>(() => undefined);
      },
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'RemoteOperationTimeoutError',
      code: 'S3_LIST_TIMEOUT',
      timeoutMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBeInstanceOf(RemoteOperationTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards parent abort through its owned signal and preserves the reason', async () => {
    const parent = new AbortController();
    let operationSignal: AbortSignal | undefined;
    const reason = new Error('poll cancelled');
    const result = runWithAbortDeadline({
      code: 'S3_FETCH_TIMEOUT',
      timeoutMs: 60_000,
      parentSignal: parent.signal,
      operation: async (signal) => {
        operationSignal = signal;
        return new Promise<string>(() => undefined);
      },
    });
    const rejection = expect(result).rejects.toBe(reason);

    parent.abort(reason);

    await rejection;
    expect(operationSignal).toBeDefined();
    expect(operationSignal).not.toBe(parent.signal);
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an operation when the parent is already aborted', async () => {
    const parent = new AbortController();
    const reason = new Error('already stopped');
    parent.abort(reason);
    const operation = vi.fn(async () => 'too late');

    await expect(runWithAbortDeadline({
      code: 'S3_BODY_TIMEOUT',
      timeoutMs: 60_000,
      parentSignal: parent.signal,
      operation,
    })).rejects.toBe(reason);

    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer and parent listener after success', async () => {
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, 'removeEventListener');

    await expect(runWithAbortDeadline({
      code: 'S3_UPLOAD_TIMEOUT',
      timeoutMs: 60_000,
      parentSignal: parent.signal,
      operation: async () => 'uploaded',
    })).resolves.toBe('uploaded');

    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cleans up after synchronous throws and asynchronous rejection', async () => {
    const syncParent = new AbortController();
    const syncRemove = vi.spyOn(syncParent.signal, 'removeEventListener');
    const syncError = new Error('sync failure');

    await expect(runWithAbortDeadline({
      code: 'S3_LIST_TIMEOUT',
      timeoutMs: 30_000,
      parentSignal: syncParent.signal,
      operation: () => {
        throw syncError;
      },
    })).rejects.toBe(syncError);

    expect(vi.getTimerCount()).toBe(0);
    expect(syncRemove).toHaveBeenCalledWith('abort', expect.any(Function));

    const asyncParent = new AbortController();
    const asyncRemove = vi.spyOn(asyncParent.signal, 'removeEventListener');
    const asyncError = new Error('async failure');

    await expect(runWithAbortDeadline({
      code: 'S3_FETCH_TIMEOUT',
      timeoutMs: 60_000,
      parentSignal: asyncParent.signal,
      operation: async () => {
        throw asyncError;
      },
    })).rejects.toBe(asyncError);

    expect(vi.getTimerCount()).toBe(0);
    expect(asyncRemove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('keeps the timeout result immutable after the operation settles late', async () => {
    const late = deferred<string>();
    const result = runWithAbortDeadline({
      code: 'POLL_TOTAL_TIMEOUT',
      timeoutMs: 14 * 60_000,
      operation: async () => late.promise,
    });
    const firstObservation = expect(result).rejects.toMatchObject({
      code: 'POLL_TOTAL_TIMEOUT',
      timeoutMs: 14 * 60_000,
    });

    await vi.advanceTimersByTimeAsync(14 * 60_000);
    await firstObservation;
    late.resolve('late success');
    await Promise.resolve();

    await expect(result).rejects.toMatchObject({
      code: 'POLL_TOTAL_TIMEOUT',
      timeoutMs: 14 * 60_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
