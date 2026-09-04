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
}>;

export interface SafeLogger {
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    eventCode: string,
    fields?: SafeLogFields,
  ): void;
}

const NUMBER_FIELDS = [
  'invalidLineCount', 'lineNumber', 'durationMs', 'count', 'backlogCount',
  'unprocessedCount',
] as const;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const EVENT_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const COMPONENT = /^[a-z][a-z0-9-]{0,63}$/;
const OPERATIONAL_ID = /^(?:[A-Za-z]+-[A-Za-z0-9._:-]+|[0-9a-f]{8}-[0-9a-f-]{27,35})$/;
const OBJECT_KEY = /^(?:inbox|events)\/[A-Za-z0-9._/-]{1,240}$/;
const OPAQUE_OBJECT_VALUE = /^[A-Za-z0-9._:/=-]{1,240}$/;
const CHECKSUM = /^[A-Za-z0-9+/=_-]{1,128}$/;
const STATUS = /^(?:[a-z][a-z0-9_]{0,63}|[A-Z][A-Z0-9_]{2,63})$/;
const FORBIDDEN_FRAGMENT = /(?:@|\s|\+\d|akia|secret|token|hmac|recovery|provider)/i;
const SAFE_ERROR_CLASSES = new Set([
  'Error', 'UnknownError', 'TypeError', 'SyntaxError', 'RangeError',
  'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'AbortError',
  'RemoteOperationTimeoutError',
]);

function safeString(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string'
    && !FORBIDDEN_FRAGMENT.test(value)
    && pattern.test(value);
}

function copySafeStringFields(entry: Record<string, unknown>, values: Record<string, unknown>): void {
  const validators: Readonly<Record<string, RegExp>> = {
    component: COMPONENT,
    requestId: OPERATIONAL_ID,
    pollId: OPERATIONAL_ID,
    objectKey: OBJECT_KEY,
    objectVersionId: OPAQUE_OBJECT_VALUE,
    objectEtag: OPAQUE_OBJECT_VALUE,
    objectChecksumSha256: CHECKSUM,
    status: STATUS,
  };
  for (const [key, pattern] of Object.entries(validators)) {
    if (safeString(values[key], pattern)) entry[key] = values[key];
  }
  if (values.objectVersionId === null) entry.objectVersionId = null;
  if (typeof values.errorClass === 'string' && SAFE_ERROR_CLASSES.has(values.errorClass)) {
    entry.errorClass = values.errorClass;
  }
}

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
      if (!LEVELS.has(level) || !safeString(eventCode, EVENT_CODE)) return;
      const entry: Record<string, unknown> = { timestamp: now(), level, eventCode };
      const values = fields as Record<string, unknown>;
      copySafeStringFields(entry, values);
      for (const key of NUMBER_FIELDS) {
        const value = values[key];
        if (typeof value === 'number' && Number.isFinite(value)) entry[key] = value;
      }
      if (
        Array.isArray(values.invalidLineNumbers)
        && values.invalidLineNumbers.every((value) => Number.isSafeInteger(value))
      ) {
        entry.invalidLineNumbers = [...values.invalidLineNumbers];
      }
      try {
        input.write(JSON.stringify(entry));
      } catch {
        // Retained diagnostics must never alter live operational control flow.
      }
    },
  };
}
