import { DomainStartupFatalError } from '../domain/startup/domainStartupTypes';

/**
 * Closed vocabulary for the one startup failure record the app may retain.
 * Stages name where startup stopped; classes are our own error names plus the
 * driver's; codes are the domain fatal codes or a SQLite result code.
 * Nothing here ever carries a message, a path or a value.
 */
export const FOUNDATION_STAGES = ['key', 'prepare', 'open', 'migrate', 'domain', 'health'] as const;
export type FoundationStage = typeof FOUNDATION_STAGES[number];
export const STARTUP_STAGES = [...FOUNDATION_STAGES, 'compose', 'window'] as const;
export type StartupStage = typeof STARTUP_STAGES[number];

export const STARTUP_ERROR_CLASSES = [
  'Error', 'UnknownError', 'TypeError', 'RangeError', 'AggregateError', 'SqliteError',
  'WorkspaceKeyUnavailableError', 'InvalidWorkspaceKeyEnvelopeError', 'WorkspaceKeyStorageError',
  'WorkspaceKeyProtectionError', 'WorkspaceKeyTemporarilyUnavailableError',
  'InvalidProtectedWorkspaceKeyError', 'WorkspaceKeyEnvelopeCorruptedError', 'InvalidKeyProtectorResultError',
  'DomainStartupFatalError', 'DomainRuntimeUnavailableError',
] as const;
export type StartupErrorClass = typeof STARTUP_ERROR_CLASSES[number];

export const DOMAIN_FATAL_CODES = [
  'storage_not_encrypted', 'schema_not_ready', 'pragma_not_ready', 'foreign_key_violation', 'fts_unavailable',
  'manifest_mismatch', 'catalog_conflict', 'active_rule_invalid', 'audit_execution_failed', 'bootstrap_failed',
] as const;
const SQLITE_CODE = /^SQLITE_[A-Z_]{1,40}$/;

export type StartupFailureRecord = Readonly<{
  stage: StartupStage;
  errorClass: StartupErrorClass;
  code?: string;
}>;

const CANCELLATION_CLASSES = new Set(['ApplicationStartupCancelledError', 'FoundationInitializationCancelledError']);

/** Startup cancelled by the user or by Electron quitting is not a failure worth a record. */
export function isStartupCancellation(error: unknown): boolean {
  return error instanceof Error && CANCELLATION_CLASSES.has(error.name);
}

export function isStartupFailureCode(value: unknown): boolean {
  return typeof value === 'string'
    && ((DOMAIN_FATAL_CODES as readonly string[]).includes(value) || SQLITE_CODE.test(value));
}

function unwrap(error: unknown): unknown {
  if (error instanceof AggregateError && error.errors.length > 0) return error.errors[0];
  return error;
}

export function classifyStartupFailure(stage: StartupStage, thrown: unknown): StartupFailureRecord {
  const error = unwrap(thrown);
  if (!(error instanceof Error)) return { stage, errorClass: 'UnknownError' };
  const errorClass: StartupErrorClass = (STARTUP_ERROR_CLASSES as readonly string[]).includes(error.name)
    ? error.name as StartupErrorClass : 'Error';
  if (error instanceof DomainStartupFatalError) return { stage, errorClass, code: error.code };
  const code = (error as { code?: unknown }).code;
  if (errorClass === 'SqliteError' && isStartupFailureCode(code)) return { stage, errorClass, code: code as string };
  return { stage, errorClass };
}
