export type RemoteOperationCode =
  | 'S3_LIST_TIMEOUT'
  | 'S3_FETCH_TIMEOUT'
  | 'S3_BODY_TIMEOUT'
  | 'S3_UPLOAD_TIMEOUT'
  | 'POLL_TOTAL_TIMEOUT';

export class RemoteOperationTimeoutError extends Error {
  readonly code: RemoteOperationCode;
  readonly timeoutMs: number;

  constructor(code: RemoteOperationCode, timeoutMs: number) {
    super(`${code} after ${timeoutMs}ms`);
    this.name = 'RemoteOperationTimeoutError';
    this.code = code;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs one remote operation behind an owned AbortController. The wrapper
 * settles independently of whether the operation cooperates with abort, while
 * still forwarding the owned signal so cooperative clients can stop work.
 */
export async function runWithAbortDeadline<T>(input: {
  code: RemoteOperationCode;
  timeoutMs: number;
  parentSignal?: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  const parentSignal = input.parentSignal;

  if (parentSignal?.aborted === true) {
    controller.abort(parentSignal.reason);
    throw parentSignal.reason;
  }

  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onOwnedAbort = (): void => {
    rejectAbort(controller.signal.reason);
  };
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason);
  };

  controller.signal.addEventListener('abort', onOwnedAbort, { once: true });
  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new RemoteOperationTimeoutError(input.code, input.timeoutMs));
  }, input.timeoutMs);

  try {
    const operation = Promise.resolve().then(() => input.operation(controller.signal));
    return await Promise.race([operation, aborted]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', onParentAbort);
    controller.signal.removeEventListener('abort', onOwnedAbort);
  }
}
