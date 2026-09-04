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

const STRING_FIELDS = [
  'component', 'requestId', 'pollId', 'objectKey', 'objectVersionId',
  'objectEtag', 'objectChecksumSha256', 'status', 'errorClass',
] as const;
const NUMBER_FIELDS = [
  'invalidLineCount', 'lineNumber', 'durationMs', 'count', 'backlogCount',
  'unprocessedCount',
] as const;
const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function sanitizeErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  return SAFE_ERROR_CLASS.test(error.name) ? error.name : 'Error';
}

export function createSafeLogger(input: {
  write(serializedEntry: string): void;
  now?: () => string;
}): SafeLogger {
  const now = input.now ?? (() => new Date().toISOString());
  return {
    log(level, eventCode, fields = {}) {
      const entry: Record<string, unknown> = { timestamp: now(), level, eventCode };
      const values = fields as Record<string, unknown>;
      for (const key of STRING_FIELDS) {
        const value = values[key];
        if (typeof value === 'string' || (key === 'objectVersionId' && value === null)) {
          entry[key] = value;
        }
      }
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
