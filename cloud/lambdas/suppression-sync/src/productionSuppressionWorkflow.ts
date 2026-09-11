import { createHash } from "node:crypto";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  createSafeLogger,
  defineLogPolicy,
  type CanonicalLogField,
  type OpaqueLogReader,
  type OpaqueLogValue,
} from "@callie-sourcing/shared";
import {
  UPLOADS_PREFIX,
  toQuarantinedEvidence,
  toValidEvidence,
  type ProductionReplaySource,
  type ReplayEvidenceObject,
  type ReplayQuarantineEntry,
} from "./replay";
import {
  SuppressionObjectValidationError,
  parseAndValidateSuppressionObject,
  type SuppressionObjectDescriptor,
  type ValidatedSuppressionObject,
} from "./suppressionObject";

const invalidPolicy = defineLogPolicy({
  component: "suppression-sync",
  events: {
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
  },
});

function createAuthority(field: CanonicalLogField): {
  issue(value: string): OpaqueLogValue;
  read: OpaqueLogReader;
} {
  const values = new WeakMap<object, string>();
  return {
    issue(value) {
      const token = Object.freeze({});
      values.set(token, value);
      return token;
    },
    read(policy, eventCode, candidateField, value) {
      if (
        policy !== invalidPolicy ||
        eventCode !== "SUPPRESSION_OBJECT_INVALID" ||
        candidateField !== field ||
        typeof value !== "object" ||
        value === null
      ) {
        return undefined;
      }
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
const invalidLog = createSafeLogger(invalidPolicy, undefined, {
  SUPPRESSION_OBJECT_INVALID: {
    objectKey: keyAuthority.read,
    objectVersionId: versionAuthority.read,
    objectEtag: etagAuthority.read,
    objectChecksumSha256: checksumAuthority.read,
  },
});

const productionS3 = new S3Client({});

type LogMetadata = Readonly<{
  objectKey?: OpaqueLogValue;
  objectVersionId?: OpaqueLogValue;
  objectEtag?: OpaqueLogValue;
}>;

type ProductionDescriptor = Readonly<{
  descriptor: SuppressionObjectDescriptor;
  metadata: LogMetadata;
}>;

function normalizeEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"')
    ? etag.slice(1, -1)
    : etag;
}

function requiredMetadata<T>(
  key: string,
  field: string,
  value: T | null | undefined,
): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(`listed suppression object ${key} is missing ${field}`);
  }
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function listProductionDescriptors(
  bucket: string,
): Promise<readonly ProductionDescriptor[]> {
  const objects: ProductionDescriptor[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  for (;;) {
    const page = await productionS3.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: UPLOADS_PREFIX,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker,
    }));

    for (const version of page.Versions ?? []) {
      const key = version.Key;
      if (!key?.endsWith(".ndjson")) continue;
      requiredMetadata(key, "ETag", version.ETag);
      requiredMetadata(key, "LastModified", version.LastModified);
      const versionId = version.VersionId ?? null;
      const etag = normalizeEtag(version.ETag);
      objects.push(Object.freeze({
        descriptor: Object.freeze({
          bucket,
          key,
          versionId,
          etag,
          lastModified: version.LastModified.toISOString(),
        }),
        metadata: Object.freeze({
          objectKey: keyAuthority.issue(key),
          ...(versionId === null
            ? {}
            : { objectVersionId: versionAuthority.issue(versionId) }),
          objectEtag: etagAuthority.issue(etag),
        }),
      }));
    }

    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) {
      throw new Error(
        "truncated suppression object version listing has no next key marker",
      );
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }

  return objects.sort((left, right) =>
    left.descriptor.lastModified.localeCompare(right.descriptor.lastModified) ||
    left.descriptor.key.localeCompare(right.descriptor.key) ||
    (left.descriptor.versionId ?? "").localeCompare(
      right.descriptor.versionId ?? "",
    ));
}

async function readProductionDescriptor(
  entry: ProductionDescriptor,
  level: "error" | "warn",
): Promise<ValidatedSuppressionObject> {
  const descriptor = entry.descriptor;
  const raw = await productionS3.send(new GetObjectCommand({
    Bucket: descriptor.bucket,
    Key: descriptor.key,
    VersionId: descriptor.versionId ?? undefined,
  }));
  const text = raw.Body
    ? await (raw.Body as { transformToString(): Promise<string> })
        .transformToString()
    : "";
  const checksumSha256 = sha256Utf8(text);

  try {
    return parseAndValidateSuppressionObject({ descriptor, text });
  } catch (error) {
    if (!(error instanceof SuppressionObjectValidationError)) throw error;
    invalidLog(level, "SUPPRESSION_OBJECT_INVALID", {
      ...entry.metadata,
      objectChecksumSha256: checksumAuthority.issue(checksumSha256),
      invalidLineNumbers: error.invalidLineNumbers,
      invalidLineCount: error.invalidLineNumbers.length,
    });
    throw new SuppressionObjectValidationError({
      key: error.key,
      versionId: error.versionId,
      invalidLineNumbers: error.invalidLineNumbers,
      checksumSha256,
    });
  }
}

export async function* iterateProductionIncrementalObjects(
  bucket: string,
  maxObjects?: number,
): AsyncIterable<ValidatedSuppressionObject> {
  const descriptors = await listProductionDescriptors(bucket);
  const selected = maxObjects === undefined
    ? descriptors
    : descriptors.slice(0, maxObjects);
  for (const descriptor of selected) {
    yield await readProductionDescriptor(descriptor, "error");
  }
}

export async function loadProductionReplaySource(
  bucket: string,
): Promise<ProductionReplaySource> {
  const descriptors = await listProductionDescriptors(bucket);
  const validObjects: ValidatedSuppressionObject[] = [];
  const quarantine: ReplayQuarantineEntry[] = [];
  const evidenceObjects: ReplayEvidenceObject[] = [];

  for (const descriptor of descriptors) {
    try {
      const object = await readProductionDescriptor(descriptor, "warn");
      validObjects.push(object);
      evidenceObjects.push(toValidEvidence(object));
    } catch (error) {
      if (!(error instanceof SuppressionObjectValidationError)) throw error;
      quarantine.push({
        key: error.key,
        versionId: error.versionId,
        invalidLineNumbers: error.invalidLineNumbers,
      });
      evidenceObjects.push(toQuarantinedEvidence(
        descriptor.descriptor,
        error,
      ));
    }
  }

  return {
    objectsSeen: descriptors.length,
    validObjects,
    quarantine,
    evidenceObjects,
  };
}

export async function loadProductionReconciliationSource(
  bucket: string,
): Promise<ProductionReplaySource> {
  const descriptors = await listProductionDescriptors(bucket);
  const validObjects: ValidatedSuppressionObject[] = [];
  const evidenceObjects: ReplayEvidenceObject[] = [];

  for (const descriptor of descriptors) {
    const object = await readProductionDescriptor(descriptor, "warn");
    validObjects.push(object);
    evidenceObjects.push(toValidEvidence(object));
  }

  return {
    objectsSeen: descriptors.length,
    validObjects,
    quarantine: [],
    evidenceObjects,
  };
}
