import { describe, expect, it } from 'vitest';

import { DomainStartupFatalError } from '../../src/main/domain/startup/domainStartupTypes';
import { FoundationInitializationCancelledError } from '../../src/main/foundation/foundationRuntime';
import { WorkspaceKeyProtectionError } from '../../src/main/security/workspaceKeyStore';
import { ApplicationStartupCancelledError } from '../../src/main/startApplication';
import {
  COMPOSITION_STAGES, DOMAIN_FATAL_CODES, FOUNDATION_STAGES, STARTUP_ERROR_CLASSES, STARTUP_STAGES,
  classifyStartupFailure, isStartupCancellation, isStartupFailureCode,
} from '../../src/main/startup/startupFailure';

class SqliteError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = 'SqliteError'; }
}

describe('classifyStartupFailure', () => {
  it('keeps only the stage, a known class name and a closed code', () => {
    expect(classifyStartupFailure('key', new WorkspaceKeyProtectionError())).toEqual({ stage: 'key', errorClass: 'WorkspaceKeyProtectionError' });
    expect(classifyStartupFailure('domain', new DomainStartupFatalError('catalog_conflict', '/Users/founder/private catalog')))
      .toEqual({ stage: 'domain', errorClass: 'DomainStartupFatalError', code: 'catalog_conflict' });
    expect(classifyStartupFailure('open', new SqliteError('file is not a database', 'SQLITE_NOTADB')))
      .toEqual({ stage: 'open', errorClass: 'SqliteError', code: 'SQLITE_NOTADB' });
  });

  it('maps unknown classes to Error, non-errors to UnknownError, and never copies a foreign code', () => {
    class PrivateContactError extends Error { constructor() { super('Ada Lovelace'); this.name = 'PrivateContactError'; } }
    expect(classifyStartupFailure('email', new PrivateContactError())).toEqual({ stage: 'email', errorClass: 'Error' });
    expect(classifyStartupFailure('window', 'private string')).toEqual({ stage: 'window', errorClass: 'UnknownError' });
    expect(classifyStartupFailure('open', new SqliteError('x', 'ADA_LOVELACE'))).toEqual({ stage: 'open', errorClass: 'SqliteError' });
    expect(classifyStartupFailure('open', Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))).toEqual({ stage: 'open', errorClass: 'Error' });
  });

  it('classifies the first inner error of an aggregate cleanup failure', () => {
    const aggregate = new AggregateError([new SqliteError('locked', 'SQLITE_BUSY'), new Error('cleanup')], 'both failed');
    expect(classifyStartupFailure('migrate', aggregate)).toEqual({ stage: 'migrate', errorClass: 'SqliteError', code: 'SQLITE_BUSY' });
    expect(classifyStartupFailure('migrate', new AggregateError([], 'empty'))).toEqual({ stage: 'migrate', errorClass: 'AggregateError' });
  });

  it('recognises cancellation and the closed code vocabulary', () => {
    expect(isStartupCancellation(new ApplicationStartupCancelledError())).toBe(true);
    expect(isStartupCancellation(new FoundationInitializationCancelledError())).toBe(true);
    expect(isStartupCancellation(new Error('Application startup was cancelled.'))).toBe(false);
    for (const code of DOMAIN_FATAL_CODES) expect(isStartupFailureCode(code)).toBe(true);
    expect(isStartupFailureCode('SQLITE_IOERR_SHORT_READ')).toBe(true);
    for (const value of ['sqlite_notadb', 'SQLITE_', 'SQLITE_ADA LOVELACE', 42, undefined, 'catalog conflict']) expect(isStartupFailureCode(value)).toBe(false);
    expect(STARTUP_STAGES).toEqual([...FOUNDATION_STAGES, ...COMPOSITION_STAGES]);
    expect(STARTUP_STAGES.at(-1)).toBe('window');
    // The background sync owner is composed after the IPC registrars, right before the window.
    expect(COMPOSITION_STAGES.indexOf('background_sync')).toBe(COMPOSITION_STAGES.indexOf('window') - 1);
    expect(COMPOSITION_STAGES.indexOf('background_sync')).toBeGreaterThan(COMPOSITION_STAGES.indexOf('ipc'));
    expect(new Set(STARTUP_ERROR_CLASSES).size).toBe(STARTUP_ERROR_CLASSES.length);
  });
});
