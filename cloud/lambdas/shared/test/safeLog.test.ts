import { describe, expect, it, vi } from "vitest";
import {
  createSafeLogger,
  defineLogPolicy,
  SafeHandlerError,
  type CanonicalLogField,
  type OpaqueLogReader,
  type OpaqueLogValue,
} from "../src/safeLog";

const policy = defineLogPolicy({
  component: "suppression-sync",
  events: {
    SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
    SUPPRESSION_OBJECT_INVALID: [
      "objectKey",
      "objectVersionId",
      "objectEtag",
      "objectChecksumSha256",
      "invalidLineNumbers",
      "invalidLineCount",
      "lineNumber",
      "errorClass",
    ],
    SUPPRESSION_OBJECT_QUARANTINED: ["objectKey", "objectChecksumSha256"],
  },
});

function createTestAuthority(policyIdentity: object, eventCode: string, field: CanonicalLogField): { issue(value: string): OpaqueLogValue; read: OpaqueLogReader } {
  const values = new WeakMap<object, string>();
  return {
    issue(value) { const token = Object.freeze({}); values.set(token, value); return token; },
    read(policy, event, candidateField, value) {
      if (policy !== policyIdentity || event !== eventCode || candidateField !== field || typeof value !== "object" || value === null) return undefined;
      const retained = values.get(value);
      if (retained !== undefined) values.delete(value);
      return retained;
    },
  };
}

const authorities = {
  objectKey: createTestAuthority(policy, "SUPPRESSION_OBJECT_INVALID", "objectKey"),
  objectVersionId: createTestAuthority(policy, "SUPPRESSION_OBJECT_INVALID", "objectVersionId"),
  objectEtag: createTestAuthority(policy, "SUPPRESSION_OBJECT_INVALID", "objectEtag"),
  objectChecksumSha256: createTestAuthority(policy, "SUPPRESSION_OBJECT_INVALID", "objectChecksumSha256"),
};

function capturedLogger() {
  const output: string[] = [];
  const write = vi.fn((serialized: string) => output.push(serialized));
  return { log: createSafeLogger(policy, write, {
    SUPPRESSION_OBJECT_INVALID: Object.fromEntries(
      Object.entries(authorities).map(([field, authority]) => [field, authority.read]),
    ),
  }), output, write };
}

function parsedOnly(output: string[]): Record<string, unknown> {
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!) as Record<string, unknown>;
}

const retainedMetadata: Partial<Record<CanonicalLogField, unknown>> = {
  objectKey: "upstream/suppression/2026-09-04/upload.ndjson",
  objectVersionId: "3LgVPH0q999-safe-version",
  objectEtag: "0123456789abcdef0123456789abcdef",
  objectChecksumSha256: "0123456789abcdef".repeat(4),
  invalidLineNumbers: [2, 7],
  invalidLineCount: 2,
  lineNumber: 7,
};

describe("createSafeLogger", () => {
  it("requires a stable event code from the closed policy", () => {
    const { log, write } = capturedLogger();

    expect(() =>
      log("info", "" as "SCHEDULED_RUN_COMPLETED", { count: 1 }),
    ).toThrow(/event code/i);
    expect(() =>
      log("info", "NOT_AUTHORIZED" as "SCHEDULED_RUN_COMPLETED", { count: 1 }),
    ).toThrow(/event code/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("omits unknown fields, nested values, and fields not authorized for the event", () => {
    const { log, output } = capturedLogger();

    log("info", "SCHEDULED_RUN_COMPLETED", {
      durationMs: 12,
      count: 3,
      unprocessedCount: 1,
      objectKey: "upstream/suppression/not-authorized-here.ndjson",
      unknown: "hidden",
      requestId: { nested: "hidden" },
    } as never);

    expect(parsedOnly(output)).toEqual({
      level: "info",
      eventCode: "SCHEDULED_RUN_COMPLETED",
      component: "suppression-sync",
      durationMs: 12,
      count: 3,
      unprocessedCount: 1,
    });
  });

  it("preserves only the authorized suppression object metadata", () => {
    const { log, output } = capturedLogger();
    const trustedMetadata = Object.fromEntries(
      Object.entries(retainedMetadata).map(([field, value]) => [
        field,
        typeof value === "string"
          ? authorities[field as keyof typeof authorities].issue(value)
          : value,
      ]),
    );

    log("error", "SUPPRESSION_OBJECT_INVALID", {
      ...trustedMetadata,
      errorClass: new TypeError("private row body"),
      contactHmac: "b".repeat(64),
      row: { email: "private@example.test" },
    } as never);

    expect(parsedOnly(output)).toEqual({
      level: "error",
      eventCode: "SUPPRESSION_OBJECT_INVALID",
      component: "suppression-sync",
      ...retainedMetadata,
      errorClass: "TypeError",
    });
  });

  it("exposes only a fixed sanitized class for thrown values", () => {
    const { log, output } = capturedLogger();
    const thrown = new Error("private@example.test token=secret-recovery-value");
    thrown.name = "private@example.test";

    log("error", "SUPPRESSION_OBJECT_INVALID", { errorClass: thrown });

    expect(parsedOnly(output)).toEqual({
      level: "error",
      eventCode: "SUPPRESSION_OBJECT_INVALID",
      component: "suppression-sync",
      errorClass: "Error",
    });
  });

  it("never serializes representative PII, secrets, contact HMACs, or row bodies", () => {
    const { log, output } = capturedLogger();
    const forbidden = [
      "Person Name",
      "Organization LLC",
      "+1-617-555-0123",
      "private@example.test",
      "12 Private Street",
      "Confidential subject",
      "Confidential message body",
      "provider-payload",
      "source-row-body",
      "b".repeat(64),
      "AKIAIOSFODNN7EXAMPLE",
      "secret-token-value",
      "recovery-material",
    ];

    log("error", "SUPPRESSION_OBJECT_INVALID", {
      ...retainedMetadata,
      personName: forbidden[0],
      organizationName: forbidden[1],
      phone: forbidden[2],
      email: forbidden[3],
      address: forbidden[4],
      subject: forbidden[5],
      body: forbidden[6],
      providerPayload: forbidden[7],
      sourceRow: forbidden[8],
      contactHmac: forbidden[9],
      awsKey: forbidden[10],
      token: forbidden[11],
      recovery: forbidden[12],
    } as never);

    const serialized = output[0]!;
    for (const value of forbidden) expect(serialized).not.toContain(value);
  });

  it("rejects accepted-shape opaque secrets at every retained string ingress", () => {
    const acceptedShapeSecrets = {
      objectKey: "upstream/suppression/AKIAIOSFODNN7EXAMPLE.ndjson",
      objectVersionId: "AKIAIOSFODNN7EXAMPLE",
      objectEtag: "b".repeat(32),
      objectChecksumSha256: "b".repeat(64),
    };

    for (const [field, value] of Object.entries(acceptedShapeSecrets)) {
      const { log, output } = capturedLogger();
      log("error", "SUPPRESSION_OBJECT_INVALID", { [field]: value } as never);
      expect(parsedOnly(output)).not.toHaveProperty(field);
    }
  });

  it("requires event-and-field-owned capabilities for every opaque metadata value", () => {
    const acceptedShapeAdversaries = {
      objectKey: "upstream/suppression/2026-09-04/private-person.ndjson",
      objectVersionId: "lowercase-secret-token",
      objectEtag: "0123456789abcdef0123456789abcdea",
      objectChecksumSha256: "0123456789abcdef".repeat(4),
    } as const;

    for (const [field, value] of Object.entries(acceptedShapeAdversaries)) {
      const { log, output } = capturedLogger();
      log("error", "SUPPRESSION_OBJECT_INVALID", { [field]: value } as never);
      expect(parsedOnly(output)).not.toHaveProperty(field);
    }

    const { log, output } = capturedLogger();
    const objectKey = authorities.objectKey.issue(acceptedShapeAdversaries.objectKey);
    log("error", "SUPPRESSION_OBJECT_INVALID", { objectKey });
    expect(parsedOnly(output)).toHaveProperty("objectKey", acceptedShapeAdversaries.objectKey);
  });

  it("does not allow a capability to cross event or field boundaries", () => {
    const { log, output } = capturedLogger();
    const contactHmac = "0123456789abcdef".repeat(4);
    const checksumCapability = authorities.objectChecksumSha256.issue(contactHmac);

    log("error", "SUPPRESSION_OBJECT_INVALID", {
      objectEtag: checksumCapability,
    } as never);

    expect(parsedOnly(output)).not.toHaveProperty("objectEtag");

    const secondEventOutput: string[] = [];
    createSafeLogger(policy, (line) => secondEventOutput.push(line), {
      SUPPRESSION_OBJECT_QUARANTINED: { objectChecksumSha256: authorities.objectChecksumSha256.read },
    })("warn", "SUPPRESSION_OBJECT_QUARANTINED", { objectChecksumSha256: checksumCapability });
    expect(parsedOnly(secondEventOutput)).not.toHaveProperty("objectChecksumSha256");

    const secondPolicy = defineLogPolicy({
      component: "suppression-sync",
      events: { SUPPRESSION_OBJECT_INVALID: ["objectChecksumSha256"] },
    });
    const secondPolicyOutput: string[] = [];
    createSafeLogger(secondPolicy, (line) => secondPolicyOutput.push(line), {
      SUPPRESSION_OBJECT_INVALID: { objectChecksumSha256: authorities.objectChecksumSha256.read },
    })("error", "SUPPRESSION_OBJECT_INVALID", { objectChecksumSha256: checksumCapability });
    expect(parsedOnly(secondPolicyOutput)).not.toHaveProperty("objectChecksumSha256");

    const reuseOutput: string[] = [];
    const sameBinding = createSafeLogger(policy, (line) => reuseOutput.push(line), {
      SUPPRESSION_OBJECT_INVALID: { objectChecksumSha256: authorities.objectChecksumSha256.read },
    });
    sameBinding("error", "SUPPRESSION_OBJECT_INVALID", { objectChecksumSha256: checksumCapability });
    sameBinding("error", "SUPPRESSION_OBJECT_INVALID", { objectChecksumSha256: checksumCapability });
    expect(reuseOutput.map((line) => JSON.parse(line).objectChecksumSha256)).toEqual([contactHmac, undefined]);
  });

  it("owns numeric validation and rejects fractional or invalid caller values", () => {
    const { log, output } = capturedLogger();
    log("info", "SCHEDULED_RUN_COMPLETED", {
      durationMs: 7.4,
      count: -1,
      unprocessedCount: Number.NaN,
    });
    expect(parsedOnly(output)).toEqual({
      level: "info",
      eventCode: "SCHEDULED_RUN_COMPLETED",
      component: "suppression-sync",
    });
  });

  it("provides a fixed outward failure class and message without a cause", () => {
    const error = new SafeHandlerError();
    expect(error.name).toBe("SafeHandlerError");
    expect(error.message).toBe("Cloud handler invocation failed");
    expect(error).not.toHaveProperty("cause");
  });
});
