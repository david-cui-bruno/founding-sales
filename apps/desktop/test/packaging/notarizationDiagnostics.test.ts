import { expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyValidationReason, observeNotarizationWrapper, observeTargetEquivalence, NotarizationWrapperError } from '../../scripts/notarizationDiagnostics.ts';
import { validateNotarization } from '../../scripts/verifyPackage.ts';

const privateText = '/private/owner-account/credential-ticket-fragment';

it.each([
  ['Could not find a ticket', 'ticket_not_found_phrase', null],
  [`Could not find a ticket for ${privateText}`, 'ticket_not_found_phrase', null],
  [`Could not validate ticket for ${privateText}`, 'ticket_validation_failed_phrase', null],
  ['The validate action failed! Error 65.', 'reported_failure', 65],
  ['The validate action failed! Error 68.', 'reported_failure', 68],
  ['The validate action failed! Error 99.', 'unknown', null],
  [privateText, 'unknown', null],
] as const)('returns only fixed classification for a synthetic phrase', (text, reason, reportedErrorCode) => {
  for (const [stdout, stderr] of [[text, null], [null, text]]) {
    const result = classifyValidationReason(stdout ?? null, stderr ?? null);
    expect(result).toEqual({ reason, reportedErrorCode });
    expect(JSON.stringify(result)).not.toContain(privateText);
  }
});

it('does not choose a precise reason from conflicting or unknown output', () => {
  expect(classifyValidationReason('Could not find a ticket\nCould not validate ticket', null)).toEqual({ reason: 'multiple_ticket_phrases', reportedErrorCode: null });
  expect(classifyValidationReason('The validate action failed! Error 65.', 'The validate action failed! Error 68.')).toEqual({ reason: 'reported_failure', reportedErrorCode: null });
  expect(classifyValidationReason(`prefix ${privateText} Could not find a ticket`, null).reason).toBe('unknown');
  expect(classifyValidationReason('x'.repeat(65_536) + '\nCould not find a ticket', null).reason).toBe('unknown');
});

it.each(['Could not find a ticket', 'The validate action worked!', privateText])('never lets recognized or unknown output override nonzero status', text => {
  const execute = vi.fn(() => ({ status: 68, signal: null, stdout: text, stderr: '' }));
  const result = validateNotarization(privateText, execute);
  expect(result.stapled).toBe(false);
  expect(result.classification).toBe('nonzero_exit');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(privateText);
});

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'callie-diagnostic-synthetic-')));
  const app = join(directory, 'Callie.app');
  mkdirSync(app);
  return { directory, app };
}

it('reports canonical and filesystem equivalence without paths or numeric identities', () => {
  const { directory, app } = fixture();
  try {
    const finish = observeTargetEquivalence(app);
    expect(finish()).toEqual({ requestedPathIsCanonical: true, canonicalTargetUnchanged: true, filesystemObjectUnchanged: true, directoryBefore: true, directoryAfter: true });
    const receipt = JSON.stringify(finish());
    expect(receipt).not.toContain(directory);
    expect(receipt).not.toContain('ino');
    expect(Object.values(finish()).every(value => value === null || typeof value === 'boolean')).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('distinguishes a retargeted symlink from an unchanged target', () => {
  const { directory, app } = fixture();
  try {
    const alternate = join(directory, 'alternate.app'), link = join(directory, 'link.app');
    mkdirSync(alternate);
    symlinkSync(app, link);
    const finish = observeTargetEquivalence(link);
    unlinkSync(link);
    symlinkSync(alternate, link);
    expect(finish()).toMatchObject({ requestedPathIsCanonical: false, canonicalTargetUnchanged: false, filesystemObjectUnchanged: false });
    expect(JSON.stringify(finish())).not.toContain(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('detects replacement at the same canonical path without reporting inode numbers', () => {
  const { directory, app } = fixture();
  try {
    const finish = observeTargetEquivalence(app);
    renameSync(app, join(directory, 'original.app'));
    mkdirSync(app);
    expect(finish()).toMatchObject({ canonicalTargetUnchanged: true, filesystemObjectUnchanged: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('keeps missing or removed target identity unknown, not falsely equivalent', () => {
  const { directory, app } = fixture();
  try {
    const missing = observeTargetEquivalence(join(directory, 'absent.app'));
    expect(missing()).toEqual({ requestedPathIsCanonical: null, canonicalTargetUnchanged: null, filesystemObjectUnchanged: null, directoryBefore: null, directoryAfter: null });
    const finish = observeTargetEquivalence(app);
    rmSync(app, { recursive: true });
    expect(finish()).toMatchObject({ canonicalTargetUnchanged: null, filesystemObjectUnchanged: null, directoryAfter: null });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('integrates target observation around exactly one injected validator execution', () => {
  const { directory, app } = fixture();
  try {
    const execute = vi.fn(() => {
      renameSync(app, join(directory, 'original.app'));
      mkdirSync(app);
      return { status: 68, signal: null, stdout: `Could not validate ticket for ${privateText}`, stderr: '' };
    });
    const result = validateNotarization(app, execute);
    expect(result).toMatchObject({ stapled: false, reason: { reason: 'ticket_validation_failed_phrase' }, target: { canonicalTargetUnchanged: true, filesystemObjectUnchanged: false } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(result)).not.toContain(privateText);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('records only honest wrapper completion, not an internal staple exit or ticket proof', async () => {
  const { directory, app } = fixture();
  try {
    const invoke = vi.fn(async () => undefined);
    const receipt = await observeNotarizationWrapper(app, invoke);
    expect(receipt).toEqual({ outcome: 'wrapper_completed', internalStapleExitObserved: false, target: { requestedPathIsCanonical: true, canonicalTargetUnchanged: true, filesystemObjectUnchanged: true, directoryBefore: true, directoryAfter: true } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(receipt)).not.toContain(directory);
    expect(JSON.stringify(receipt)).not.toContain('stapled');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.each(['reject', 'throw'] as const)('sanitizes wrapper %s failure with a receipt and no fallback, retry or original message', async mode => {
  const { directory, app } = fixture();
  try {
    const invoke = vi.fn(() => {
      if (mode === 'throw') throw new Error(privateText);
      return Promise.reject(new Error(privateText));
    });
    let error: unknown;
    try { await observeNotarizationWrapper(app, invoke); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(NotarizationWrapperError);
    if (!(error instanceof NotarizationWrapperError)) throw new Error('synthetic_wrapper_error_missing');
    expect(error.receipt).toMatchObject({ outcome: 'wrapper_failed', internalStapleExitObserved: false });
    expect(`${error.message}${error.stack}${JSON.stringify(error)}`).not.toContain(privateText);
    expect(JSON.stringify(error)).not.toContain(directory);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
