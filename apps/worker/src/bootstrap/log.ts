/**
 * Structured, redacted process logging.
 *
 * The shape is not free: `infra/modules/observability/main.tf` turns log events into
 * CloudWatch metrics with filter patterns over `$.level` and `$.event`, so every line
 * is one JSON object with those two fields at the top level. A line that is not JSON,
 * or that carries the event name somewhere else, is a metric that never increments.
 *
 * Values are primitives only, truncated, and any field whose *name* looks like a
 * credential is replaced rather than printed. The rule the whole tree follows is that
 * a log line may name a variable and never its value.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export type LogValue = string | number | boolean | null | undefined;
export interface LogFields {
  readonly [field: string]: LogValue;
}

export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void;
}

/** Field names that never carry their value into a log line, whatever they hold. */
const SENSITIVE_FIELD = /(secret|password|token|credential|authorization|cookie|connection|url|dsn|arn)/i;

/** A value long enough to be a body, a stack or a query is not an operator hint. */
const MAX_VALUE_LENGTH = 200;

export const REDACTED = '[redacted]';

function redactField(name: string, value: LogValue): LogValue {
  if (value === undefined) return undefined;
  if (SENSITIVE_FIELD.test(name)) return REDACTED;
  if (typeof value !== 'string') return value;
  return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
}

export interface LoggerOptions {
  /** `fss` is the operations command line, which shares this log group and shape. */
  readonly component: 'worker' | 'api' | 'fss';
  readonly instanceKey: string;
  /** Where the line goes. Defaults to stdout, which is what the awslogs driver reads. */
  readonly write?: ((line: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
  const now = options.now ?? ((): Date => new Date());
  return {
    log(level, event, fields) {
      const line: Record<string, LogValue> = {
        ts: now().toISOString(),
        level,
        component: options.component,
        instance: options.instanceKey,
        event,
      };
      for (const [name, value] of Object.entries(fields ?? {})) {
        if (name === 'ts' || name === 'level' || name === 'component' || name === 'event') continue;
        const redacted = redactField(name, value);
        if (redacted !== undefined) line[name] = redacted;
      }
      write(JSON.stringify(line));
    },
  };
}

/** A logger that keeps its lines, for tests that assert an event was raised. */
export function recordingLogger(): Logger & { readonly lines: readonly Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const inner = createLogger({
    component: 'worker',
    instanceKey: 'recording',
    write: line => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { lines, log: (level, event, fields) => inner.log(level, event, fields) };
}

/**
 * The one way an unknown thrown value becomes a log field: a name and a bounded
 * message, never a stack and never a `cause` that may carry a host or a statement.
 */
export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error_name: error.name, error_message: error.message.slice(0, MAX_VALUE_LENGTH) };
  }
  return { error_name: 'unknown', error_message: 'a value that is not an Error was thrown' };
}
