import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface TargetEquivalence {
  readonly requestedPathIsCanonical: boolean | null;
  readonly canonicalTargetUnchanged: boolean | null;
  readonly filesystemObjectUnchanged: boolean | null;
  readonly directoryBefore: boolean | null;
  readonly directoryAfter: boolean | null;
}

/** Raw identities stay inside this closure, never in a returned receipt or error. */
export function observeTargetEquivalence(appPath: string): () => TargetEquivalence {
  const snapshot = () => {
    try {
      const canonical = realpathSync(appPath);
      const file = statSync(canonical);
      return { canonical, dev: file.dev, ino: file.ino, directory: file.isDirectory() };
    } catch {
      return null;
    }
  };
  const before = snapshot();
  return () => {
    const after = snapshot();
    return {
      requestedPathIsCanonical: before === null ? null : before.canonical === resolve(appPath),
      canonicalTargetUnchanged: before === null || after === null ? null : before.canonical === after.canonical,
      filesystemObjectUnchanged: before === null || after === null ? null : before.dev === after.dev && before.ino === after.ino,
      directoryBefore: before?.directory ?? null,
      directoryAfter: after?.directory ?? null,
    };
  };
}

export interface ValidationReason {
  readonly reason: 'ticket_not_found_phrase' | 'ticket_validation_failed_phrase' | 'multiple_ticket_phrases' | 'reported_failure' | 'unknown';
  readonly reportedErrorCode: 65 | 68 | null;
}

/** Classify only fixed phrases. Suffixes, paths, arbitrary codes and raw output never escape. */
export function classifyValidationReason(stdout: string | null, stderr: string | null): ValidationReason {
  const reasons = new Set<'ticket_not_found_phrase' | 'ticket_validation_failed_phrase'>();
  const codes = new Set<65 | 68>();
  for (const text of [stdout, stderr]) {
    for (const line of (text ?? '').slice(0, 65_536).split(/\r?\n/u)) {
      if (/^Could not find a ticket(?: for .*)?$/u.test(line)) reasons.add('ticket_not_found_phrase');
      if (/^Could not validate ticket(?: for .*)?$/u.test(line)) reasons.add('ticket_validation_failed_phrase');
      if (line === 'The validate action failed! Error 65.') codes.add(65);
      if (line === 'The validate action failed! Error 68.') codes.add(68);
    }
  }
  return {
    reason: reasons.size > 1 ? 'multiple_ticket_phrases' : reasons.values().next().value ?? (codes.size > 0 ? 'reported_failure' : 'unknown'),
    reportedErrorCode: codes.size === 1 ? codes.values().next().value ?? null : null,
  };
}

export interface NotarizationWrapperReceipt {
  readonly outcome: 'wrapper_completed' | 'wrapper_failed';
  readonly internalStapleExitObserved: false;
  readonly target: TargetEquivalence;
}

export class NotarizationWrapperError extends Error {
  readonly receipt: NotarizationWrapperReceipt;
  constructor(receipt: NotarizationWrapperReceipt) {
    super('PACKAGE: notarization wrapper failed. See the sanitized wrapper receipt.');
    this.name = 'NotarizationWrapperError';
    this.receipt = receipt;
  }
}

/** Observes wrapper completion only, not the dependency's internal submission or staple subprocesses. */
export async function observeNotarizationWrapper(appPath: string, invoke: () => Promise<void>): Promise<NotarizationWrapperReceipt> {
  const finish = observeTargetEquivalence(appPath);
  try {
    await invoke();
  } catch {
    throw new NotarizationWrapperError({ outcome: 'wrapper_failed', internalStapleExitObserved: false, target: finish() });
  }
  return { outcome: 'wrapper_completed', internalStapleExitObserved: false, target: finish() };
}
