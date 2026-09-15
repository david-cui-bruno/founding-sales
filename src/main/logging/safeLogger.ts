import { companyResearchStages, companyResearchReasons } from '../research/companyResearchFailure';

export type SafeLogFields = Readonly<{
  component?: string;
  requestId?: string;
  pollId?: string;
  objectKey?: string;
  objectVersionId?: string | null;
  objectEtag?: string;
  objectChecksumSha256?: string;
  invalidLineNumbers?: readonly number[];
  invalidLineCount?: number;
  lineNumber?: number;
  durationMs?: number;
  count?: number;
  backlogCount?: number;
  unprocessedCount?: number;
  status?: string;
  errorClass?: string;
  stage?: string;
  reason?: string;
  httpStatus?: number;
}>;

export interface SafeLogger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    eventCode: string,
    fields?: SafeLogFields,
  ): void;
}

type FieldValidator = (value: unknown) => boolean;
type EventPolicy = Readonly<{
  level: 'debug' | 'info' | 'warn' | 'error';
  component: 'sourcing-poller' | 'sourcing-credential-store' | 'company-research';
  fields: Readonly<Record<string, FieldValidator>>;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const EVENT_OBJECT_KEY = /^events\/(\d{4}-\d{2}-\d{2})\/(boston-assessments|boston-rentsmart|pvd-taxroll|enricher|mail-parse|scorer)-([0-9A-HJKMNP-TV-Z]{26})\.ndjson$/;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'UnknownError', 'TypeError', 'SyntaxError', 'RangeError',
  'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError',
  'RemoteOperationTimeoutError',
]);
const POLL_FAILURE_STATUSES = new Set([
  'POLL_FAILED', 'S3_LIST_TIMEOUT', 'S3_FETCH_TIMEOUT', 'S3_BODY_TIMEOUT',
  'S3_UPLOAD_TIMEOUT', 'POLL_TOTAL_TIMEOUT',
]);

function isCanonicalUtcDate(value: string): boolean {
  try {
    return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  } catch {
    return false;
  }
}

function isGeneratedObjectKey(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = EVENT_OBJECT_KEY.exec(value);
  return match !== null && isCanonicalUtcDate(match[1]!) && ULID.test(match[3]!);
}

const isUuid: FieldValidator = (value) => typeof value === 'string' && UUID.test(value);
const isErrorClass: FieldValidator = (value) => (
  typeof value === 'string' && SAFE_ERROR_CLASSES.has(value)
);
const isNonNegativeInteger: FieldValidator = (value) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
);
const isPositiveInteger: FieldValidator = (value) => (
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
);
const isOneOf = (...values: readonly string[]): FieldValidator => {
  const allowed = new Set(values);
  return (value) => typeof value === 'string' && allowed.has(value);
};

const EVENT_POLICIES: Readonly<Record<string, EventPolicy>> = {
  COMPANY_RESEARCH_PARKED: {
    level: 'warn', component: 'company-research',
    fields: { requestId: isUuid, stage: isOneOf(...companyResearchStages), reason: isOneOf(...companyResearchReasons),
      httpStatus: value => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 },
  },
  SOURCING_FILE_FAILED: {
    level: 'error', component: 'sourcing-poller',
    fields: { pollId: isUuid, objectKey: isGeneratedObjectKey, errorClass: isErrorClass },
  },
  SOURCING_UPSTREAM_SYNC_FAILED: {
    level: 'error', component: 'sourcing-poller',
    fields: { pollId: isUuid, errorClass: isErrorClass },
  },
  SOURCING_LINE_QUARANTINED: {
    level: 'warn', component: 'sourcing-poller',
    fields: { objectKey: isGeneratedObjectKey, lineNumber: isPositiveInteger },
  },
  SOURCING_IDEMPOTENCY_CONFLICT: {
    level: 'warn', component: 'sourcing-poller', fields: { errorClass: isErrorClass },
  },
  SOURCING_NEEDS_IDENTITY_SKIPPED: {
    level: 'info', component: 'sourcing-poller',
    fields: { status: isOneOf('no_usable_situs') },
  },
  SOURCING_SCORE_UPDATE_SKIPPED: {
    level: 'info', component: 'sourcing-poller',
    fields: { status: isOneOf('no_intake_receipt') },
  },
  SOURCING_POLL_FAILED: {
    level: 'error', component: 'sourcing-poller',
    fields: {
      pollId: isUuid,
      backlogCount: isNonNegativeInteger,
      status: (value) => typeof value === 'string' && POLL_FAILURE_STATUSES.has(value),
      errorClass: isErrorClass,
    },
  },
  SOURCING_CREDENTIALS_PROTECTED: {
    level: 'info', component: 'sourcing-credential-store',
    fields: { status: isOneOf('protected') },
  },
};

export function sanitizeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  return SAFE_ERROR_CLASSES.has(error.name) ? error.name : 'Error';
}

export function createSafeLogger(input: {
  write(serializedEntry: string): void;
  now?: () => string;
}): SafeLogger {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    log(level, eventCode, fields = {}) {
      const policy = EVENT_POLICIES[eventCode];
      if (policy === undefined || level !== policy.level || fields.component !== policy.component) {
        return;
      }
      const entry: Record<string, unknown> = {
        timestamp: now(), level, eventCode, component: policy.component,
      };
      const values = fields as Record<string, unknown>;
      for (const [field, validate] of Object.entries(policy.fields)) {
        if (validate(values[field])) entry[field] = values[field];
      }
      try {
        input.write(JSON.stringify(entry));
      } catch {
        // Retained diagnostics must never alter live operational control flow.
      }
    },
  };
}
