import { createHash } from "node:crypto";
import {
  suppressionUploadLineSchema,
  type SuppressionUploadLine,
} from "@callie-sourcing/shared";

export type SuppressionObjectDescriptor = Readonly<{
  bucket: string;
  key: string;
  versionId: string | null;
  etag: string;
  lastModified: string;
}>;

export type ValidatedSuppressionObject = Readonly<{
  descriptor: SuppressionObjectDescriptor;
  checksumSha256: string;
  lines: readonly SuppressionUploadLine[];
  validRowCount: number;
}>;

export class SuppressionObjectValidationError extends Error {
  readonly key: string;
  readonly versionId: string | null;
  readonly invalidLineNumbers: readonly number[];
  readonly checksumSha256?: string;

  constructor(input: {
    key: string;
    versionId: string | null;
    invalidLineNumbers: readonly number[];
    checksumSha256?: string;
  }) {
    super(`invalid suppression object lines: ${input.invalidLineNumbers.join(",")}`);
    this.name = "SuppressionObjectValidationError";
    this.key = input.key;
    this.versionId = input.versionId;
    this.invalidLineNumbers = input.invalidLineNumbers;
    this.checksumSha256 = input.checksumSha256;
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

export function parseAndValidateSuppressionObject(input: {
  descriptor: SuppressionObjectDescriptor;
  text: string;
}): ValidatedSuppressionObject {
  const checksumSha256 = sha256Utf8(input.text);
  const lines: SuppressionUploadLine[] = [];
  const invalidLineNumbers: number[] = [];

  for (const [index, line] of input.text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = suppressionUploadLineSchema.safeParse(JSON.parse(line));
      if (parsed.success) lines.push(parsed.data);
      else invalidLineNumbers.push(index + 1);
    } catch {
      invalidLineNumbers.push(index + 1);
    }
  }

  if (invalidLineNumbers.length > 0) {
    throw new SuppressionObjectValidationError({
      key: input.descriptor.key,
      versionId: input.descriptor.versionId,
      invalidLineNumbers,
    });
  }

  return {
    descriptor: input.descriptor,
    checksumSha256,
    lines,
    validRowCount: lines.length,
  };
}

export function ledgerNaturalKey(object: ValidatedSuppressionObject): string {
  const canonical = JSON.stringify({
    bucket: object.descriptor.bucket,
    key: object.descriptor.key,
    versionId: object.descriptor.versionId,
    etag: object.descriptor.etag,
    checksumSha256: object.checksumSha256,
  });
  return `suppression-sync:${sha256Utf8(canonical)}`;
}
