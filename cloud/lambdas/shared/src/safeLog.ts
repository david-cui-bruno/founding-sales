export type LogLevel = "info" | "warn" | "error";

export type CanonicalLogField =
  | "component"
  | "requestId"
  | "pollId"
  | "objectKey"
  | "objectVersionId"
  | "objectEtag"
  | "objectChecksumSha256"
  | "invalidLineNumbers"
  | "invalidLineCount"
  | "lineNumber"
  | "durationMs"
  | "count"
  | "backlogCount"
  | "unprocessedCount"
  | "status"
  | "errorClass";

type EventPolicy = Readonly<Record<string, readonly CanonicalLogField[]>>;

export interface LogPolicy<
  Component extends string,
  Events extends EventPolicy,
> {
  readonly component: Component;
  readonly events: Events;
}

type EventCode<Events extends EventPolicy> = Extract<keyof Events, string>;
type EventFields<
  Events extends EventPolicy,
  Code extends EventCode<Events>,
> = Partial<Record<Events[Code][number], unknown>>;

const SAFE_ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "AggregateError",
]);

const INTEGER_FIELDS = new Set<CanonicalLogField>([
  "durationMs",
  "count",
  "backlogCount",
  "unprocessedCount",
  "invalidLineCount",
  "lineNumber",
]);

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function isUniform(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character === value[0]);
}

function safeObjectKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^upstream\/suppression\/\d{4}-\d{2}-\d{2}\/[a-z0-9][a-z0-9._-]{0,127}\.ndjson$/.test(value)) {
    return undefined;
  }
  if (/AKIA|ASIA/.test(value)) return undefined;
  return value;
}

function safeVersionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(value)) return undefined;
  if (/^(?:AKIA|ASIA)/.test(value)) return undefined;
  return value;
}

function safeHex(value: unknown, length: number): string | undefined {
  if (typeof value !== "string" || !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(value)) {
    return undefined;
  }
  return isUniform(value.toLowerCase()) ? undefined : value.toLowerCase();
}

function safeErrorClass(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Error)) return "UnknownError";
  return SAFE_ERROR_CLASSES.has(value.name) ? value.name : "Error";
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return undefined;
  }
  return value;
}

function sanitizeField(field: CanonicalLogField, value: unknown): unknown {
  if (INTEGER_FIELDS.has(field)) return safeInteger(value);

  switch (field) {
    case "component":
      return undefined;
    case "requestId":
    case "pollId":
    case "status":
      return safeIdentifier(value);
    case "objectKey":
      return safeObjectKey(value);
    case "objectVersionId":
      return safeVersionId(value);
    case "objectEtag":
      return safeHex(value, 32);
    case "objectChecksumSha256":
      return safeHex(value, 64);
    case "invalidLineNumbers":
      if (!Array.isArray(value)) return undefined;
      if (!value.every((line) => safeInteger(line) !== undefined && line > 0)) return undefined;
      return [...value];
    case "errorClass":
      return safeErrorClass(value);
  }
}

export function defineLogPolicy<
  const Component extends string,
  const Events extends EventPolicy,
>(policy: LogPolicy<Component, Events>): LogPolicy<Component, Events> {
  return Object.freeze({
    component: policy.component,
    events: Object.freeze(
      Object.fromEntries(
        Object.entries(policy.events).map(([eventCode, fields]) => [
          eventCode,
          Object.freeze([...fields]),
        ]),
      ),
    ) as Events,
  });
}

export function createSafeLogger<
  const Component extends string,
  const Events extends EventPolicy,
>(
  policy: LogPolicy<Component, Events>,
  write: (serialized: string) => void = (serialized) => console.log(serialized),
): <Code extends EventCode<Events>>(
  level: LogLevel,
  eventCode: Code,
  fields?: EventFields<Events, Code>,
) => void {
  return (level, eventCode, fields = {}) => {
    const allowedFields = policy.events[eventCode];
    if (!eventCode || !allowedFields) {
      throw new Error("A stable event code from the closed log policy is required");
    }

    const record: Record<string, unknown> = {
      level,
      eventCode,
      component: policy.component,
    };
    const inputFields = fields as Partial<Record<CanonicalLogField, unknown>>;
    for (const field of allowedFields) {
      if (!Object.prototype.hasOwnProperty.call(inputFields, field)) continue;
      const sanitized = sanitizeField(field, inputFields[field]);
      if (sanitized !== undefined) record[field] = sanitized;
    }
    write(JSON.stringify(record));
  };
}
