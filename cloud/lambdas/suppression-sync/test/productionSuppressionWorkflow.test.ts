import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const productionS3Send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send = productionS3Send; } };
});

import {
  iterateProductionIncrementalObjects,
  loadProductionReconciliationSource,
  loadProductionReplaySource,
} from "../src/productionSuppressionWorkflow";
import * as productionWorkflow from "../src/productionSuppressionWorkflow";
import { SuppressionObjectValidationError } from "../src/suppressionObject";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const KEY = "upstream/suppression/2026-09-04/120000-batch.ndjson";
const SECOND_KEY = "upstream/suppression/2026-09-04/120001-batch.ndjson";
const VERSION = "version-1";
const SECOND_VERSION = "version-2";
const ETAG = "etag-1";
const SECOND_ETAG = "etag-2";
const PRIVATE_EMAIL = "private@example.test";
const PRIVATE_PHONE = "+1-401-555-0199";
const PRIVATE_HMAC = "b".repeat(64);
const PRIVATE_BODY = [
  PRIVATE_EMAIL,
  PRIVATE_PHONE,
  PRIVATE_HMAC,
  "credential",
  "provider_payload",
  "raw error message",
  "cause",
].join(" ");
const VALID_BODY = `${JSON.stringify({
  contact_hmac: "a".repeat(64),
  kind: "email",
  reason: "opt_out",
  observed_at: "2026-09-04T11:00:00.000Z",
})}\n`;
const sha256 = (value: string) =>
  createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

function listedVersions(includeInvalid = true) {
  return {
    Versions: [
      {
        Key: KEY,
        VersionId: VERSION,
        ETag: `"${ETAG}"`,
        LastModified: NOW,
      },
      ...(includeInvalid
        ? [{
            Key: SECOND_KEY,
            VersionId: SECOND_VERSION,
            ETag: `"${SECOND_ETAG}"`,
            LastModified: new Date(NOW.getTime() + 1_000),
          }]
        : []),
    ],
    IsTruncated: false,
  };
}

function body(text: string) {
  return { Body: { transformToString: async () => text } };
}

function invalidRecords(output: readonly string[]): Array<Record<string, unknown>> {
  return output
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.eventCode === "SUPPRESSION_OBJECT_INVALID");
}

function expectNoPrivateDiagnosticData(serialized: string): void {
  expect(serialized).not.toContain(PRIVATE_BODY);
  expect(serialized).not.toContain(PRIVATE_EMAIL);
  expect(serialized).not.toContain(PRIVATE_PHONE);
  expect(serialized).not.toContain(PRIVATE_HMAC);
  expect(serialized).not.toContain("contact_hmac");
  expect(serialized).not.toContain("credential");
  expect(serialized).not.toContain("provider_payload");
  expect(serialized).not.toContain("raw error message");
  expect(serialized).not.toContain("cause");
  expect(serialized).not.toContain("Body");
}

beforeEach(() => productionS3Send.mockReset());

describe("sealed production suppression workflow", () => {
  it("exports only atomic production acquisition operations", () => {
    expect(Object.keys(productionWorkflow).sort()).toEqual([
      "iterateProductionIncrementalObjects",
      "loadProductionReconciliationSource",
      "loadProductionReplaySource",
    ]);
    expect(productionWorkflow).not.toHaveProperty("productionSuppressionObjectSource");
    expect(productionWorkflow).not.toHaveProperty("readProductionObject");
    expect(productionWorkflow).not.toHaveProperty("logSuppressionObjectDiagnostic");
  });

  it("yields incremental objects sequentially and emits one full error diagnostic for an invalid object", async () => {
    productionS3Send
      .mockResolvedValueOnce(listedVersions())
      .mockResolvedValueOnce(body(VALID_BODY))
      .mockResolvedValueOnce(body(PRIVATE_BODY));
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    let failure: unknown;
    try {
      const iterator = iterateProductionIncrementalObjects("inbox")[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.descriptor).toMatchObject({ key: KEY, versionId: VERSION });
      expect(productionS3Send).toHaveBeenCalledTimes(2);
      failure = await iterator.next().then(() => undefined, (error) => error);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(failure).toBeInstanceOf(SuppressionObjectValidationError);
    const escaped = failure as SuppressionObjectValidationError;
    expect(escaped).toMatchObject({
      key: SECOND_KEY,
      versionId: SECOND_VERSION,
      invalidLineNumbers: [1],
      checksumSha256: sha256(PRIVATE_BODY),
    });
    for (const property of [
      "metadata",
      "logMetadata",
      "reader",
      "callback",
      "cause",
      "body",
      "rawBody",
      "diagnosticLevel",
      "level",
    ]) {
      expect(escaped).not.toHaveProperty(property);
    }

    const invalid = invalidRecords(output);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({
      level: "error",
      component: "suppression-sync",
      eventCode: "SUPPRESSION_OBJECT_INVALID",
      objectKey: SECOND_KEY,
      objectVersionId: SECOND_VERSION,
      objectEtag: SECOND_ETAG,
      objectChecksumSha256: sha256(PRIVATE_BODY),
      invalidLineNumbers: [1],
      invalidLineCount: 1,
    });
    expect(Object.keys(invalid[0]!).sort()).toEqual([
      "component",
      "eventCode",
      "invalidLineCount",
      "invalidLineNumbers",
      "level",
      "objectChecksumSha256",
      "objectEtag",
      "objectKey",
      "objectVersionId",
    ].sort());
    expectNoPrivateDiagnosticData(output.join("\n"));
  });

  it("loads replay history with one full warn diagnostic and quarantined evidence", async () => {
    productionS3Send
      .mockResolvedValueOnce(listedVersions())
      .mockResolvedValueOnce(body(VALID_BODY))
      .mockResolvedValueOnce(body(PRIVATE_BODY));
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    let source;
    try {
      source = await loadProductionReplaySource("inbox");
    } finally {
      consoleSpy.mockRestore();
    }

    expect(source.objectsSeen).toBe(2);
    expect(source.validObjects).toHaveLength(1);
    expect(source.quarantine).toEqual([{
      key: SECOND_KEY,
      versionId: SECOND_VERSION,
      invalidLineNumbers: [1],
    }]);
    expect(Object.keys(source.quarantine[0]!).sort()).toEqual([
      "invalidLineNumbers",
      "key",
      "versionId",
    ]);
    expect(source.evidenceObjects).toEqual([
      {
        key: KEY,
        versionId: VERSION,
        etag: ETAG,
        lastModified: NOW.toISOString(),
        checksumSha256: sha256(VALID_BODY),
        status: "valid",
      },
      {
        key: SECOND_KEY,
        versionId: SECOND_VERSION,
        etag: SECOND_ETAG,
        lastModified: new Date(NOW.getTime() + 1_000).toISOString(),
        checksumSha256: sha256(PRIVATE_BODY),
        status: "quarantined",
      },
    ]);
    expect(JSON.stringify(source.evidenceObjects)).not.toContain(PRIVATE_BODY);
    expect(JSON.stringify(source.evidenceObjects)).not.toContain("contact_hmac");

    const invalid = invalidRecords(output);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({
      level: "warn",
      objectKey: SECOND_KEY,
      objectVersionId: SECOND_VERSION,
      objectEtag: SECOND_ETAG,
      objectChecksumSha256: sha256(PRIVATE_BODY),
      invalidLineNumbers: [1],
      invalidLineCount: 1,
    });
    expect(invalid.some((record) => record.level === "error")).toBe(false);
    expectNoPrivateDiagnosticData(output.join("\n"));
  });

  it("fails reconciliation atomically after one full warn diagnostic for an invalid object", async () => {
    productionS3Send
      .mockResolvedValueOnce(listedVersions())
      .mockResolvedValueOnce(body(VALID_BODY))
      .mockResolvedValueOnce(body(PRIVATE_BODY));
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    try {
      await expect(loadProductionReconciliationSource("inbox")).rejects.toMatchObject({
        key: SECOND_KEY,
        versionId: SECOND_VERSION,
        invalidLineNumbers: [1],
        checksumSha256: sha256(PRIVATE_BODY),
      });
    } finally {
      consoleSpy.mockRestore();
    }

    const invalid = invalidRecords(output);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({
      level: "warn",
      objectKey: SECOND_KEY,
      objectVersionId: SECOND_VERSION,
      objectEtag: SECOND_ETAG,
      objectChecksumSha256: sha256(PRIVATE_BODY),
      invalidLineNumbers: [1],
      invalidLineCount: 1,
    });
    expectNoPrivateDiagnosticData(output.join("\n"));
  });

  it("loads valid reconciliation evidence without changing ordinary object metadata", async () => {
    productionS3Send
      .mockResolvedValueOnce(listedVersions(false))
      .mockResolvedValueOnce(body(VALID_BODY));

    const source = await loadProductionReconciliationSource("inbox");

    expect(source).toEqual({
      objectsSeen: 1,
      validObjects: [expect.objectContaining({
        descriptor: {
          bucket: "inbox",
          key: KEY,
          versionId: VERSION,
          etag: ETAG,
          lastModified: NOW.toISOString(),
        },
        checksumSha256: sha256(VALID_BODY),
        validRowCount: 1,
      })],
      quarantine: [],
      evidenceObjects: [{
        key: KEY,
        versionId: VERSION,
        etag: ETAG,
        lastModified: NOW.toISOString(),
        checksumSha256: sha256(VALID_BODY),
        status: "valid",
      }],
    });
  });
});
