import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  defineLogPolicy,
  type CanonicalLogField,
  type OpaqueLogReader,
  suppressionUploadLineSchema,
  type OpaqueLogValue,
  type SuppressionUploadLine,
} from "@callie-sourcing/shared";

export const suppressionLogPolicy = defineLogPolicy({
  component: "suppression-sync",
  events: {
    SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
    SUPPRESSION_OBJECT_INVALID: ["objectKey", "objectVersionId", "objectEtag", "objectChecksumSha256", "invalidLineNumbers", "invalidLineCount", "lineNumber", "errorClass"],
    SUPPRESSION_MAINTENANCE_COMPLETED: ["count", "unprocessedCount"],
  },
});

function createAuthority(field: CanonicalLogField): { issue(value: string): OpaqueLogValue; read: OpaqueLogReader } {
  const values = new WeakMap<object, string>();
  return {
    issue(value) { const token = Object.freeze({}); values.set(token, value); return token; },
    read(policy, eventCode, candidateField, value) {
      if (policy !== suppressionLogPolicy || eventCode !== "SUPPRESSION_OBJECT_INVALID" || candidateField !== field || typeof value !== "object" || value === null) return undefined;
      const retained = values.get(value);
      if (retained !== undefined) values.delete(value);
      return retained;
    },
  };
}
const keyAuthority = createAuthority("objectKey");
const versionAuthority = createAuthority("objectVersionId");
const etagAuthority = createAuthority("objectEtag");
const checksumAuthority = createAuthority("objectChecksumSha256");

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
  readonly logMetadata?: SuppressionObjectLogMetadata;
  readonly checksumSha256?: string;

  constructor(input: {
    key: string;
    versionId: string | null;
    invalidLineNumbers: readonly number[];
    logMetadata?: SuppressionObjectLogMetadata;
    checksumSha256?: string;
  }) {
    super(`invalid suppression object lines: ${input.invalidLineNumbers.join(",")}`);
    this.name = "SuppressionObjectValidationError";
    this.key = input.key;
    this.versionId = input.versionId;
    this.invalidLineNumbers = input.invalidLineNumbers;
    this.logMetadata = input.logMetadata;
    this.checksumSha256 = input.checksumSha256;
  }
}

type SuppressionS3Deps = Readonly<{
  s3: Pick<S3Client, "send">;
  env: { INBOX_BUCKET: string };
}>;

function normalizeEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

function requiredMetadata(key: string, field: string, value: unknown): asserts value {
  if (value === undefined || value === null) throw new Error(`listed suppression object ${key} is missing ${field}`);
}

export async function listSuppressionObjectsFromS3(deps: SuppressionS3Deps, prefix: string): Promise<SuppressionObjectDescriptor[]> {
  const objects: SuppressionObjectDescriptor[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  while (true) {
    const page = await deps.s3.send(new ListObjectVersionsCommand({ Bucket: deps.env.INBOX_BUCKET, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
    for (const version of page.Versions ?? []) {
      const key = version.Key;
      if (!key?.endsWith(".ndjson")) continue;
      requiredMetadata(key, "ETag", version.ETag);
      requiredMetadata(key, "LastModified", version.LastModified);
      const versionId = version.VersionId ?? null;
      const etag = normalizeEtag(version.ETag);
      objects.push({
        bucket: deps.env.INBOX_BUCKET,
        key,
        versionId,
        etag,
        lastModified: version.LastModified.toISOString(),
        logMetadata: {
          objectKey: keyAuthority.issue(key),
          ...(versionId === null ? {} : { objectVersionId: versionAuthority.issue(versionId) }),
          objectEtag: etagAuthority.issue(etag),
        },
      });
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw new Error("truncated suppression object version listing has no next key marker");
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  return objects.sort((left, right) => left.lastModified.localeCompare(right.lastModified) || left.key.localeCompare(right.key) || (left.versionId ?? "").localeCompare(right.versionId ?? ""));
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
    logMetadata: input.descriptor.logMetadata ?? {},
    lines,
    validRowCount: lines.length,
  };
}

export async function readValidatedSuppressionObjectFromS3(
  deps: SuppressionS3Deps,
  descriptor: SuppressionObjectDescriptor,
): Promise<ValidatedSuppressionObject> {
  const raw = await deps.s3.send(new GetObjectCommand({ Bucket: descriptor.bucket, Key: descriptor.key, VersionId: descriptor.versionId ?? undefined }));
  const text = raw.Body ? await (raw.Body as { transformToString(): Promise<string> }).transformToString() : "";
  const checksumSha256 = sha256Utf8(text);
  const logMetadata = { ...descriptor.logMetadata, objectChecksumSha256: checksumAuthority.issue(checksumSha256) };
  try {
    const parsed = parseAndValidateSuppressionObject({ descriptor, text });
    return { ...parsed, logMetadata };
  } catch (error) {
    if (error instanceof SuppressionObjectValidationError) {
      throw new SuppressionObjectValidationError({
        key: error.key,
        versionId: error.versionId,
        invalidLineNumbers: error.invalidLineNumbers,
        logMetadata,
        checksumSha256,
      });
    }
    throw error;
  }
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
