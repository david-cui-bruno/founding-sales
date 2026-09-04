import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SuppressionObjectValidationError,
  ledgerNaturalKey,
  parseAndValidateSuppressionObject,
  type SuppressionObjectDescriptor,
} from "../src/suppressionObject";

const DESCRIPTOR: SuppressionObjectDescriptor = {
  bucket: "inbox",
  key: "upstream/suppression/2026-09-04/one.ndjson",
  versionId: "version-1",
  etag: "etag-1",
  lastModified: "2026-09-04T12:00:00.000Z",
};

const VALID_LINE = {
  contact_hmac: "a".repeat(64),
  kind: "phone",
  reason: "opt_out",
  observed_at: "2026-09-04T11:00:00.000Z",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

describe("parseAndValidateSuppressionObject", () => {
  it("validates every nonblank line and hashes the exact UTF-8 body", () => {
    const text = `\n${JSON.stringify(VALID_LINE)}\n  \n${JSON.stringify({
      ...VALID_LINE,
      contact_hmac: "b".repeat(64),
      kind: "email",
    })}\n`;

    const object = parseAndValidateSuppressionObject({ descriptor: DESCRIPTOR, text });

    expect(object.descriptor).toEqual(DESCRIPTOR);
    expect(object.lines).toHaveLength(2);
    expect(object.validRowCount).toBe(2);
    expect(object.checksumSha256).toBe(sha256(text));
  });

  it("reports every invalid physical line number while ignoring blank lines", () => {
    const contactData = "person@example.com";
    const text = [
      "",
      JSON.stringify(VALID_LINE),
      JSON.stringify({ ...VALID_LINE, contact_hmac: contactData }),
      "   ",
      "not-json +1-401-555-0199",
      JSON.stringify({ ...VALID_LINE, contact_hmac: "c".repeat(64) }),
    ].join("\n");

    let caught: unknown;
    try {
      parseAndValidateSuppressionObject({ descriptor: DESCRIPTOR, text });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SuppressionObjectValidationError);
    const error = caught as SuppressionObjectValidationError;
    expect(error.key).toBe(DESCRIPTOR.key);
    expect(error.versionId).toBe(DESCRIPTOR.versionId);
    expect(error.invalidLineNumbers).toEqual([3, 5]);
    expect(error.message).not.toContain(contactData);
    expect(error.message).not.toContain("401-555-0199");
  });
});

describe("ledgerNaturalKey", () => {
  it("uses a canonical collision-safe identity including the exact body checksum", () => {
    const text = `${JSON.stringify(VALID_LINE)}\n`;
    const object = parseAndValidateSuppressionObject({ descriptor: DESCRIPTOR, text });
    const canonical = JSON.stringify({
      bucket: DESCRIPTOR.bucket,
      key: DESCRIPTOR.key,
      versionId: DESCRIPTOR.versionId,
      etag: DESCRIPTOR.etag,
      checksumSha256: sha256(text),
    });

    expect(ledgerNaturalKey(object)).toBe(`suppression-sync:${sha256(canonical)}`);

    const ambiguousA = parseAndValidateSuppressionObject({
      descriptor: { ...DESCRIPTOR, bucket: "a", key: "bc" },
      text,
    });
    const ambiguousB = parseAndValidateSuppressionObject({
      descriptor: { ...DESCRIPTOR, bucket: "ab", key: "c" },
      text,
    });
    expect(ledgerNaturalKey(ambiguousA)).not.toBe(ledgerNaturalKey(ambiguousB));
  });
});
