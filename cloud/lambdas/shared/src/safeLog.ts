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

export class SafeHandlerError extends Error {
  constructor() {
    super("Cloud handler invocation failed");
    this.name = "SafeHandlerError";
  }
}

type TrustedValueMetadata = {
  policy: object;
  eventCode: string;
  field: CanonicalLogField;
  value: string;
};

const trustedValues = new WeakMap<object, TrustedValueMetadata>();
const OPAQUE_FIELDS = new Set<CanonicalLogField>([
  "objectKey",
  "objectVersionId",
  "objectEtag",
  "objectChecksumSha256",
]);

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

function safeErrorClass(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Error)) return "UnknownError";
  return SAFE_ERROR_CLASSES.has(value.name) ? value.name : "Error";
}

function sanitizeField(
  policy: object,
  eventCode: string,
  field: CanonicalLogField,
  value: unknown,
): unknown {
  if (INTEGER_FIELDS.has(field)) return safeInteger(value);

  if (OPAQUE_FIELDS.has(field)) {
    if (typeof value !== "object" || value === null) return undefined;
    const trusted = trustedValues.get(value);
    return trusted?.policy === policy &&
      trusted.eventCode === eventCode &&
      trusted.field === field
      ? trusted.value
      : undefined;
  }

  switch (field) {
    case "component":
      return undefined;
    case "requestId":
    case "pollId":
    case "status":
      return undefined;
    case "objectKey":
    case "objectVersionId":
    case "objectEtag":
    case "objectChecksumSha256":
      return undefined;
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
): (<Code extends EventCode<Events>>(
  level: LogLevel,
  eventCode: Code,
  fields?: EventFields<Events, Code>,
) => void) & {
  trust<Code extends EventCode<Events>>(
    eventCode: Code,
    field: Events[Code][number],
    value: string,
  ): object;
} {
  const logger = (<Code extends EventCode<Events>>(
    level: LogLevel,
    eventCode: Code,
    fields: EventFields<Events, Code> = {},
  ) => {
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
      const sanitized = sanitizeField(policy, eventCode, field, inputFields[field]);
      if (sanitized !== undefined) record[field] = sanitized;
    }
    write(JSON.stringify(record));
  }) as ReturnType<typeof createSafeLogger<Component, Events>>;

  logger.trust = (eventCode, field, value) => {
    const allowedFields = policy.events[eventCode];
    if (!allowedFields?.includes(field) || !OPAQUE_FIELDS.has(field)) {
      throw new Error("Trusted values require an authorized opaque event field");
    }
    const capability = Object.freeze({});
    trustedValues.set(capability, { policy, eventCode, field, value });
    return capability;
  };
  return logger;
}
