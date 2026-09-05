import { createHash } from "node:crypto";
import {
  createOpaqueLogValueAuthority,
  suppressionUploadLineSchema,
  type OpaqueLogValue,
  type SuppressionUploadLine,
} from "@callie-sourcing/shared";

const keyAuthority = createOpaqueLogValueAuthority();
const versionAuthority = createOpaqueLogValueAuthority();
const etagAuthority = createOpaqueLogValueAuthority();
const checksumAuthority = createOpaqueLogValueAuthority();

export const suppressionObjectLogReaders = Object.freeze({
  objectKey: keyAuthority.read,
  objectVersionId: versionAuthority.read,
  objectEtag: etagAuthority.read,
  objectChecksumSha256: checksumAuthority.read,
});

export type SuppressionObjectLogMetadata = Readonly<{
  objectKey?: OpaqueLogValue;
  objectVersionId?: OpaqueLogValue;
  objectEtag?: OpaqueLogValue;
  objectChecksumSha256?: OpaqueLogValue;
}>;

export type SuppressionObjectDescriptor = Readonly<{
  bucket: string;
  key: string;
  versionId: string | null;
  etag: string;
  lastModified: string;
  logMetadata?: SuppressionObjectLogMetadata;
}>;

export type ValidatedSuppressionObject = Readonly<{
  descriptor: SuppressionObjectDescriptor;
  checksumSha256: string;
  logMetadata: SuppressionObjectLogMetadata;
  lines: readonly SuppressionUploadLine[];
  validRowCount: number;
}>;

export class SuppressionObjectValidationError extends Error {
  readonly key: string;
  readonly versionId: string | null;
  readonly invalidLineNumbers: readonly number[];
  readonly logMetadata: SuppressionObjectLogMetadata;

  constructor(input: {
    key: string;
    versionId: string | null;
    invalidLineNumbers: readonly number[];
    logMetadata: SuppressionObjectLogMetadata;
  }) {
    super(`invalid suppression object lines: ${input.invalidLineNumbers.join(",")}`);
    this.name = "SuppressionObjectValidationError";
    this.key = input.key;
    this.versionId = input.versionId;
    this.invalidLineNumbers = input.invalidLineNumbers;
    this.logMetadata = input.logMetadata;
  }
}

export function suppressionObjectDescriptorFromAws(input: Omit<SuppressionObjectDescriptor, "logMetadata">): SuppressionObjectDescriptor {
  return {
    ...input,
    logMetadata: {
      objectKey: keyAuthority.issue(input.key),
      ...(input.versionId === null ? {} : { objectVersionId: versionAuthority.issue(input.versionId) }),
      objectEtag: etagAuthority.issue(input.etag),
    },
  };
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

export function parseAndValidateSuppressionObject(input: {
  descriptor: SuppressionObjectDescriptor;
  text: string;
}): ValidatedSuppressionObject {
  const checksumSha256 = sha256Utf8(input.text);
  const logMetadata = {
    ...input.descriptor.logMetadata,
    objectChecksumSha256: checksumAuthority.issue(checksumSha256),
  };
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
      logMetadata,
    });
  }

  return {
    descriptor: input.descriptor,
    checksumSha256,
    logMetadata,
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
