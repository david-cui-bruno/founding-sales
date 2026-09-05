import { createHash } from "node:crypto";
import { GetObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import {
  createSafeLogger,
  defineLogPolicy,
  suppressionUploadLineSchema,
  type CanonicalLogField,
  type LogLevel,
  type OpaqueLogReader,
  type OpaqueLogValue,
  type SuppressionUploadLine,
} from "@callie-sourcing/shared";

const invalidPolicy = defineLogPolicy({
  component: "suppression-sync",
  events: {
    SUPPRESSION_OBJECT_INVALID: ["objectKey", "objectVersionId", "objectEtag", "objectChecksumSha256", "invalidLineNumbers", "invalidLineCount", "lineNumber", "errorClass"],
  },
});

function createAuthority(field: CanonicalLogField): { issue(value: string): OpaqueLogValue; read: OpaqueLogReader } {
  const values = new WeakMap<object, string>();
  return {
    issue(value) { const token = Object.freeze({}); values.set(token, value); return token; },
    read(policy, eventCode, candidateField, value) {
      if (policy !== invalidPolicy || eventCode !== "SUPPRESSION_OBJECT_INVALID" || candidateField !== field || typeof value !== "object" || value === null) return undefined;
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
const invalidLog = createSafeLogger(invalidPolicy, undefined, { SUPPRESSION_OBJECT_INVALID: {
  objectKey: keyAuthority.read,
  objectVersionId: versionAuthority.read,
  objectEtag: etagAuthority.read,
  objectChecksumSha256: checksumAuthority.read,
} });

type LogMetadata = Readonly<{
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
  constructor(input: { key: string; versionId: string | null; invalidLineNumbers: readonly number[]; checksumSha256?: string }) {
    super(`invalid suppression object lines: ${input.invalidLineNumbers.join(",")}`);
    this.name = "SuppressionObjectValidationError";
    this.key = input.key;
    this.versionId = input.versionId;
    this.invalidLineNumbers = input.invalidLineNumbers;
    this.checksumSha256 = input.checksumSha256;
  }
}

export interface SuppressionObjectSource {
  list(bucket: string, prefix: string): Promise<SuppressionObjectDescriptor[]>;
  read(descriptor: SuppressionObjectDescriptor, diagnosticLevel?: "error" | "warn"): Promise<ValidatedSuppressionObject>;
}

const productionS3 = new S3Client({});
const descriptorMetadata = new WeakMap<SuppressionObjectDescriptor, LogMetadata>();
const validationMetadata = new WeakMap<SuppressionObjectValidationError, LogMetadata>();

function normalizeEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}
function requiredMetadata(key: string, field: string, value: unknown): asserts value {
  if (value === undefined || value === null) throw new Error(`listed suppression object ${key} is missing ${field}`);
}
function sha256Utf8(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function listProductionObjects(bucket: string, prefix: string): Promise<SuppressionObjectDescriptor[]> {
  const objects: SuppressionObjectDescriptor[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  while (true) {
    const page = await productionS3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
    for (const version of page.Versions ?? []) {
      const key = version.Key;
      if (!key?.endsWith(".ndjson")) continue;
      requiredMetadata(key, "ETag", version.ETag);
      requiredMetadata(key, "LastModified", version.LastModified);
      const versionId = version.VersionId ?? null;
      const etag = normalizeEtag(version.ETag);
      const descriptor: SuppressionObjectDescriptor = Object.freeze({ bucket, key, versionId, etag, lastModified: version.LastModified.toISOString() });
      descriptorMetadata.set(descriptor, {
        objectKey: keyAuthority.issue(key),
        ...(versionId === null ? {} : { objectVersionId: versionAuthority.issue(versionId) }),
        objectEtag: etagAuthority.issue(etag),
      });
      objects.push(descriptor);
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw new Error("truncated suppression object version listing has no next key marker");
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  return objects.sort((a, b) => a.lastModified.localeCompare(b.lastModified) || a.key.localeCompare(b.key) || (a.versionId ?? "").localeCompare(b.versionId ?? ""));
}

export function parseAndValidateSuppressionObject(input: { descriptor: SuppressionObjectDescriptor; text: string }): ValidatedSuppressionObject {
  const checksumSha256 = sha256Utf8(input.text);
  const lines: SuppressionUploadLine[] = [];
  const invalidLineNumbers: number[] = [];
  for (const [index, line] of input.text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = suppressionUploadLineSchema.safeParse(JSON.parse(line));
      if (parsed.success) lines.push(parsed.data);
      else invalidLineNumbers.push(index + 1);
    } catch { invalidLineNumbers.push(index + 1); }
  }
  if (invalidLineNumbers.length > 0) throw new SuppressionObjectValidationError({ key: input.descriptor.key, versionId: input.descriptor.versionId, invalidLineNumbers });
  return { descriptor: input.descriptor, checksumSha256, lines, validRowCount: lines.length };
}

async function readProductionObject(descriptor: SuppressionObjectDescriptor, diagnosticLevel: "error" | "warn" = "error"): Promise<ValidatedSuppressionObject> {
  const listedMetadata = descriptorMetadata.get(descriptor);
  if (!listedMetadata) throw new Error("suppression object was not issued by the production list source");
  const raw = await productionS3.send(new GetObjectCommand({ Bucket: descriptor.bucket, Key: descriptor.key, VersionId: descriptor.versionId ?? undefined }));
  const text = raw.Body ? await (raw.Body as { transformToString(): Promise<string> }).transformToString() : "";
  const checksumSha256 = sha256Utf8(text);
  const metadata = { ...listedMetadata, objectChecksumSha256: checksumAuthority.issue(checksumSha256) };
  try { return parseAndValidateSuppressionObject({ descriptor, text }); }
  catch (error) {
    if (!(error instanceof SuppressionObjectValidationError)) throw error;
    const internal = new SuppressionObjectValidationError({ key: error.key, versionId: error.versionId, invalidLineNumbers: error.invalidLineNumbers, checksumSha256 });
    validationMetadata.set(internal, metadata);
    writeFullDiagnostic(diagnosticLevel, internal);
    throw new SuppressionObjectValidationError({ key: error.key, versionId: error.versionId, invalidLineNumbers: error.invalidLineNumbers, checksumSha256 });
  }
}

export const productionSuppressionObjectSource: SuppressionObjectSource = Object.freeze({ list: listProductionObjects, read: readProductionObject });

function writeFullDiagnostic(level: LogLevel, error: SuppressionObjectValidationError, lineNumber?: number): void {
  invalidLog(level, "SUPPRESSION_OBJECT_INVALID", {
    ...validationMetadata.get(error),
    invalidLineNumbers: error.invalidLineNumbers,
    invalidLineCount: error.invalidLineNumbers.length,
    lineNumber,
  });
}

export function ledgerNaturalKey(object: ValidatedSuppressionObject): string {
  const canonical = JSON.stringify({ bucket: object.descriptor.bucket, key: object.descriptor.key, versionId: object.descriptor.versionId, etag: object.descriptor.etag, checksumSha256: object.checksumSha256 });
  return `suppression-sync:${sha256Utf8(canonical)}`;
}
