# Sealed Suppression Production Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace suppression-sync's injectable split production source with a sealed production acquisition workflow while preserving exact full production diagnostics and aggregate-only injected diagnostics.

**Architecture:** The deployed Lambda entry uses a new non-injectable production workflow that owns S3 list, fetch, body hashing, validation, mode-derived diagnostic level, and metadata consumption as one call graph. Exported `runHandler` and `createHandler` remain deterministic capability-free seams, while shared incremental and replay processing receives only ordinary validated objects, quarantine entries, and aggregates.

**Tech Stack:** TypeScript 5.7, Node 24, Vitest 2.1, AWS SDK v3 S3 and DynamoDB clients, existing `@callie-sourcing/shared` closed logger.

**Spec:** `docs/superpowers/specs/2026-09-05-sealed-suppression-production-diagnostics-design.md`

## Global Constraints

- Production schedules remain disabled.
- Do not invoke Lambda, AWS, Terraform, provider APIs, deployments, outreach, Callie, Apple bridge, or live data.
- Prefix every `npm` or `npx` command exactly with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";`.
- Keep full production object metadata authority private to the new production workflow.
- No exported or injectable API may expose a production descriptor between list and read.
- No exported or injectable API may accept a production diagnostic level.
- Production incremental invalid objects emit exactly one full `error` diagnostic and fail closed.
- Production replay invalid objects emit exactly one full `warn` diagnostic, quarantine, and continue.
- Capability-free injected invalid objects emit exactly one aggregate-only diagnostic at the mode-derived level.
- Preserve sequential incremental processing. A valid object completed before a later invalid selected object remains completed.
- Preserve ledger keys, membership merge semantics, replay report shape, reconciliation, scheduled completion mapping, PII exclusions, and fixed outward `SafeHandlerError` behavior.
- Modify only the files declared below. Stop with `NEEDS_CONTEXT` before editing any additional path.

---

### Task 1: Seal production acquisition and separate capability-free injection

This is intentionally one atomic task. A partial commit would either leave the unsafe split production source reachable or introduce an unused duplicate metadata-authority implementation.

**Files:**
- Create: `cloud/lambdas/suppression-sync/src/productionSuppressionWorkflow.ts`
- Create: `cloud/lambdas/suppression-sync/test/productionSuppressionWorkflow.test.ts`
- Modify: `cloud/lambdas/suppression-sync/src/suppressionObject.ts`
- Modify: `cloud/lambdas/suppression-sync/src/replay.ts`
- Modify: `cloud/lambdas/suppression-sync/src/handler.ts`
- Modify: `cloud/lambdas/suppression-sync/src/log.ts`
- Modify: `cloud/lambdas/suppression-sync/test/handler.test.ts`
- Modify: `cloud/lambdas/suppression-sync/test/replay.test.ts`

**Interfaces:**
- Consumes:
  - `parseAndValidateSuppressionObject(input)` and `ValidatedSuppressionObject` from `src/suppressionObject.ts`
  - existing closed `SUPPRESSION_OBJECT_INVALID` logging field policy
  - existing replay persistence, reconciliation, evidence, and report-writing behavior
- Produces:

```ts
export interface CapabilityFreeSuppressionObjectSource {
  list(
    bucket: string,
    prefix: string,
  ): Promise<readonly SuppressionObjectDescriptor[]>;
  read(
    descriptor: SuppressionObjectDescriptor,
  ): Promise<ValidatedSuppressionObject>;
}

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  env: {
    INBOX_BUCKET: string;
    SNAPSHOTS_TABLE: string;
    SUPPRESSION_TABLE: string;
  };
  now?: () => Date;
  runId?: (timestamp: number) => string;
  capabilityFreeObjectSource?: CapabilityFreeSuppressionObjectSource;
}

export type ProductionHandlerDeps = Omit<
  HandlerDeps,
  "capabilityFreeObjectSource"
>;

export function createProductionHandler(
  depsFactory: () => ProductionHandlerDeps,
  monotonicNow?: () => number,
): (event?: unknown) => Promise<HandlerResult | SuppressionReplayResult>;
```

```ts
export type ReplayQuarantineEntry = Readonly<{
  key: string;
  versionId: string | null;
  invalidLineNumbers: readonly number[];
}>;

export type ReplayEvidenceObject = Readonly<{
  key: string;
  versionId: string | null;
  etag: string;
  lastModified: string;
  checksumSha256: string;
  status: "valid" | "quarantined";
}>;

export type ProductionReplaySource = Readonly<{
  objectsSeen: number;
  validObjects: readonly ValidatedSuppressionObject[];
  quarantine: readonly ReplayQuarantineEntry[];
  evidenceObjects: readonly ReplayEvidenceObject[];
}>;
```

```ts
export async function* iterateProductionIncrementalObjects(
  bucket: string,
  maxObjects?: number,
): AsyncIterable<ValidatedSuppressionObject>;

export async function loadProductionReplaySource(
  bucket: string,
): Promise<ProductionReplaySource>;

export async function loadProductionReconciliationSource(
  bucket: string,
): Promise<ProductionReplaySource>;
```

```ts
export async function runReplayFromLoadedSource(
  deps: HandlerDeps,
  input: { dryRun: boolean; now: Date; runId: string },
  source: ProductionReplaySource,
): Promise<SuppressionReplayResult>;

export async function runReconciliationFromLoadedSource(
  deps: HandlerDeps,
  input: { reportKey: string; now: Date },
  source: ProductionReplaySource,
): Promise<SuppressionReplayResult>;
```

- `productionSuppressionWorkflow.ts` exports only the three atomic high-level production acquisition functions at runtime. It does not export a client, descriptor reader, log policy, authority, reader, consumer, diagnostic level, or split source object.
- `runHandler` and `createHandler` use only capability-free acquisition.
- The deployed `handler` uses private `runProductionHandler` through `createProductionHandler`. The production factory accepts only `ProductionHandlerDeps` and never accepts, returns, or replaces either atomic production acquisition function.

- [ ] **Step 1: Write failing production-workflow boundary tests**

Create `test/productionSuppressionWorkflow.test.ts` with a hoisted SDK mock before importing the new module:

```ts
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

const NOW = new Date("2026-09-04T12:00:00.000Z");
const KEY = "upstream/suppression/2026-09-04/120000-batch.ndjson";
const VERSION = "version-1";
const ETAG = "etag-1";
const PRIVATE_BODY = "private@example.test";
const sha256 = (value: string) =>
  createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");

beforeEach(() => productionS3Send.mockReset());
```

Add an export-surface test that rejects the old split boundary and any level-bearing reader:

```ts
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
```

Add an incremental test whose S3 mock returns one valid object followed by one invalid object. Consume the async iterator one item at a time. Assert:

- the first object is yielded before requesting the second item
- the invalid second item emits exactly one `SUPPRESSION_OBJECT_INVALID` record at `error`
- the record contains exact key, version, normalized ETag, `sha256(PRIVATE_BODY)`, and line aggregates
- the record contains no row body, contact HMAC, email, phone number, credential, provider payload, raw error message, or cause
- no duplicate aggregate record exists
- the escaped `SuppressionObjectValidationError` has no opaque metadata, reader, callback, cause, raw body, or log-level property
- `PRIVATE_BODY` is absent from serialized logs

Add replay and reconciliation tests with one valid and one invalid retained version.

For replay, assert:

- exactly one full invalid diagnostic at `warn`
- no `error` diagnostic for that object
- `objectsSeen === 2`, `validObjects.length === 1`, and `quarantine.length === 1`
- quarantine contains only key, version ID, and invalid line numbers
- evidence contains the exact checksum but no body or contact row

For reconciliation, assert:

- exactly one full invalid diagnostic at `warn`
- the atomic loader rejects instead of returning a source with quarantine
- no aggregate duplicate is emitted
- a valid-only source returns ordinary objects and preserves exact evidence fields

- [ ] **Step 2: Write failing capability-free integration tests**

In `test/handler.test.ts`, remove imports and assertions for `productionSuppressionObjectSource`. Import `createProductionHandler`, `CapabilityFreeSuppressionObjectSource`, and `ProductionHandlerDeps`. Add a compile-visible fake implementing the new capability-free property:

```ts
const capabilityFreeObjectSource: CapabilityFreeSuppressionObjectSource = {
  list: async () => [descriptor],
  read: async () => {
    throw new SuppressionObjectValidationError({
      key: descriptor.key,
      versionId: descriptor.versionId,
      invalidLineNumbers: [1],
      checksumSha256: "f".repeat(64),
    });
  },
};

const deps = fakeDeps(state());
deps.capabilityFreeObjectSource = capabilityFreeObjectSource;
```

Add three assertions:

1. Incremental emits exactly one aggregate `error` record with `invalidLineNumbers` and `invalidLineCount`, no key/version/ETag/checksum, then fails through the fixed outward boundary.
2. Replay emits exactly one aggregate `warn` record, quarantines the object, continues, and emits no full metadata.
3. Reconciliation emits exactly one aggregate `warn` record, fails closed, and emits no full metadata.

In `test/replay.test.ts`, update fake dependency construction to use `capabilityFreeObjectSource` only in cases that explicitly test the source seam. Add a test proving an injected fake cannot suppress aggregate logging by adding arbitrary properties such as `ownsDiagnostics: true` or `sourceKind: "production"`.

Add a sequential production integration regression in `test/handler.test.ts` using the existing hoisted `productionS3Send` mock and `createProductionHandler(() => fakeDeps(s) satisfies ProductionHandlerDeps)`:

- two selected production objects
- first object valid, second invalid
- first object's membership and ledger writes occur before the second object's failure
- the failure does not roll back or repeat the first object's completed writes
- exactly one full `error` diagnostic belongs to the second object
- the exported boundary rejects with the fixed `SafeHandlerError`

- [ ] **Step 3: Run the focused tests and confirm genuine RED**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm --prefix cloud/lambdas/suppression-sync test -- --run test/productionSuppressionWorkflow.test.ts test/handler.test.ts test/replay.test.ts
```

Expected RED evidence must include at least:

- missing `../src/productionSuppressionWorkflow`
- `HandlerDeps` missing `capabilityFreeObjectSource`
- the old production split source still exported or the new export-surface assertion failing
- injected fake source producing zero aggregate diagnostics under the current guard

Do not weaken the assertions to obtain RED.

- [ ] **Step 4: Make `suppressionObject.ts` capability-free**

Remove all AWS SDK, shared opaque logging, production S3 client, `descriptorMetadata`, `validationMetadata`, production list/read, full diagnostic serializer, `SuppressionObjectSource`, and `productionSuppressionObjectSource` code from `src/suppressionObject.ts`.

Keep only:

- `SuppressionObjectDescriptor`
- `ValidatedSuppressionObject`
- `SuppressionObjectValidationError`
- `parseAndValidateSuppressionObject`
- `ledgerNaturalKey`
- pure SHA-256 helper used by parsing and ledger identity

The escaped validation error remains ordinary data:

```ts
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
```

Do not add any diagnostic ownership marker, brand, boolean, token, reader, or log-level field to this error.

- [ ] **Step 5: Implement the sealed production workflow**

Create `src/productionSuppressionWorkflow.ts`. Move the existing closed invalid-object policy, private authorities/readers, logger, module-private `S3Client`, deterministic version pagination, body fetch, checksum, and validation into this module.

Use separate private functions and no exported split source:

```ts
const productionS3 = new S3Client({});

type ProductionDescriptor = Readonly<{
  descriptor: SuppressionObjectDescriptor;
  metadata: LogMetadata;
}>;

async function listProductionDescriptors(
  bucket: string,
): Promise<readonly ProductionDescriptor[]> {
  const objects: ProductionDescriptor[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  while (true) {
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
```

`ProductionDescriptor` is module-private and carries private log metadata. It must not be assignable from an ordinary exported `SuppressionObjectDescriptor` without passing through the real list operation.

Implement the public atomic operations:

```ts
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
```

The exact diagnostic level appears only in private calls above. The three exported function signatures contain no diagnostic-level input.

- [ ] **Step 6: Separate replay acquisition from replay processing**

In `src/replay.ts`:

1. Rename the structural source to `CapabilityFreeSuppressionObjectSource`.
2. Rename `HandlerDeps.objectSource` to `HandlerDeps.capabilityFreeObjectSource`.
3. Remove the `diagnosticLevel` parameter from the capability-free source's `read` method and from the capability-free `readValidatedObject` helper.
4. Export `ReplayQuarantineEntry`, `ReplayEvidenceObject`, and `ProductionReplaySource` with the exact shapes above.
5. Make the capability-free replay acquisition function always emit one aggregate `warn` diagnostic when it catches `SuppressionObjectValidationError`. It quarantines only when `quarantineInvalid` is true and otherwise rethrows after logging.
6. Extract replay application into `runReplayFromLoadedSource`.
7. Extract reconciliation application into `runReconciliationFromLoadedSource`.

Before implementing either loader, extract these ordinary evidence converters in `replay.ts` and reuse them from the production module:

```ts
export function toValidEvidence(
  object: ValidatedSuppressionObject,
): ReplayEvidenceObject {
  return {
    key: object.descriptor.key,
    versionId: object.descriptor.versionId,
    etag: object.descriptor.etag,
    lastModified: object.descriptor.lastModified,
    checksumSha256: object.checksumSha256,
    status: "valid",
  };
}

export function toQuarantinedEvidence(
  descriptor: SuppressionObjectDescriptor,
  error: SuppressionObjectValidationError,
): ReplayEvidenceObject {
  if (!error.checksumSha256) {
    throw new Error("quarantined suppression object is missing checksum");
  }
  return {
    key: descriptor.key,
    versionId: descriptor.versionId,
    etag: descriptor.etag,
    lastModified: descriptor.lastModified,
    checksumSha256: error.checksumSha256,
    status: "quarantined",
  };
}
```

The capability-free source-loading implementation is:

```ts
async function loadCapabilityFreeReplaySource(
  deps: HandlerDeps,
  quarantineInvalid: boolean,
): Promise<ProductionReplaySource> {
  const descriptors = await listUploadObjects(deps);
  const validObjects: ValidatedSuppressionObject[] = [];
  const quarantine: ReplayQuarantineEntry[] = [];
  const evidenceObjects: ReplayEvidenceObject[] = [];

  for (const descriptor of descriptors) {
    try {
      const object = await readValidatedObject(deps, descriptor);
      validObjects.push(object);
      evidenceObjects.push(toValidEvidence(object));
    } catch (error) {
      if (!(error instanceof SuppressionObjectValidationError)) throw error;
      log("warn", "suppression_object_invalid_aggregate", {
        invalid_line_numbers: error.invalidLineNumbers,
        invalid_line_count: error.invalidLineNumbers.length,
      });
      if (!quarantineInvalid) throw error;
      quarantine.push({
        key: error.key,
        versionId: error.versionId,
        invalidLineNumbers: error.invalidLineNumbers,
      });
      evidenceObjects.push(toQuarantinedEvidence(descriptor, error));
    }
  }

  return {
    objectsSeen: descriptors.length,
    validObjects,
    quarantine,
    evidenceObjects,
  };
}

export async function runReplay(
  deps: HandlerDeps,
  input: { dryRun: boolean; now: Date; runId: string },
): Promise<SuppressionReplayResult> {
  return runReplayFromLoadedSource(
    deps,
    input,
    await loadCapabilityFreeReplaySource(deps, true),
  );
}

export async function runReconciliation(
  deps: HandlerDeps,
  input: { reportKey: string; now: Date },
): Promise<SuppressionReplayResult> {
  assertReportKey(input.reportKey);
  return runReconciliationFromLoadedSource(
    deps,
    input,
    await loadCapabilityFreeReplaySource(deps, false),
  );
}
```

`runReplayFromLoadedSource` derives the union and checksum from `source.validObjects`, uses `source.objectsSeen`, `source.quarantine`, and `source.evidenceObjects`, and preserves the existing report shape and immutable write behavior.

`runReconciliationFromLoadedSource` begins by calling `assertReportKey(input.reportKey)`, derives the same union and checksum, preserves current missing and unexpected membership counting, and never accepts a source containing quarantine entries. Add this invariant immediately after report-key validation:

```ts
if (source.quarantine.length > 0) {
  throw new Error("reconciliation source cannot contain quarantined objects");
}
```

- [ ] **Step 7: Separate capability-free and production handler call graphs**

In `src/handler.ts`, keep exported `runHandler` capability-free. Its incremental path uses `capabilityFreeObjectSource` or structural test S3 and always logs one aggregate `error` diagnostic on `SuppressionObjectValidationError`.

Extract object processing so both call graphs preserve identical ledger and membership behavior:

```ts
async function processIncrementalObjects(
  deps: HandlerDeps,
  objects: AsyncIterable<ValidatedSuppressionObject>,
  now: Date,
): Promise<HandlerResult> {
  const result: HandlerResult = {
    filesSeen: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    linesWritten: 0,
    invalidLines: 0,
  };

  for await (const object of objects) {
    result.filesSeen += 1;
    if (await ledgerHas(deps, object)) {
      result.filesSkipped += 1;
      continue;
    }
    for (const line of object.lines) {
      if (await persistSuppressionMonotonically(deps, line, now)) {
        result.linesWritten += 1;
      }
    }
    await ledgerMark(deps, object, now);
    result.filesProcessed += 1;
  }

  return result;
}
```

The capability-free incremental loader yields ordinary objects and owns aggregate logging:

```ts
async function* iterateCapabilityFreeIncrementalObjects(
  deps: HandlerDeps,
  maxObjects?: number,
): AsyncIterable<ValidatedSuppressionObject> {
  const descriptors = await listUploadObjects(deps);
  const selected = maxObjects === undefined
    ? descriptors
    : descriptors.slice(0, maxObjects);
  for (const descriptor of selected) {
    try {
      yield await readValidatedObject(deps, descriptor);
    } catch (error) {
      if (error instanceof SuppressionObjectValidationError) {
        log("error", "suppression_object_invalid_aggregate", {
          invalid_line_numbers: error.invalidLineNumbers,
          invalid_line_count: error.invalidLineNumbers.length,
        });
      }
      throw error;
    }
  }
}
```

Add a private production dispatcher:

```ts
async function runProductionHandler(
  deps: ProductionHandlerDeps,
  event: unknown = {},
): Promise<HandlerResult | SuppressionReplayResult> {
  const parsedEvent = parseSuppressionSyncEvent(event);
  const now = deps.now ? deps.now() : new Date();
  const runId = deps.runId ? deps.runId(now.getTime()) : ulid(now.getTime());

  if (parsedEvent.mode === "replay") {
    const source = await loadProductionReplaySource(deps.env.INBOX_BUCKET);
    return runReplayFromLoadedSource(deps, {
      dryRun: parsedEvent.dryRun,
      now,
      runId,
    }, source);
  }
  if (parsedEvent.mode === "reconcile") {
    const source = await loadProductionReconciliationSource(
      deps.env.INBOX_BUCKET,
    );
    return runReconciliationFromLoadedSource(deps, {
      reportKey: parsedEvent.reportKey,
      now,
    }, source);
  }
  return processIncrementalObjects(
    deps,
    iterateProductionIncrementalObjects(
      deps.env.INBOX_BUCKET,
      parsedEvent.maxObjects,
    ),
    now,
  );
}
```

Refactor the safe exported wrapper so both capability-free and production handlers retain identical timing, one completion in `finally`, result mapping, and fresh `SafeHandlerError` behavior:

```ts
function createSafeInvocation(
  run: (event: unknown) => Promise<HandlerResult | SuppressionReplayResult>,
  monotonicNow: () => number,
): (event?: unknown) => Promise<HandlerResult | SuppressionReplayResult> {
  return async (event = {}) => {
    const startedAt = monotonicNow();
    let result: HandlerResult | SuppressionReplayResult | undefined;
    try {
      result = await run(event);
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      logScheduledCompletion(result, event, Math.max(
        0,
        Math.round(monotonicNow() - startedAt),
      ));
    }
  };
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
) {
  return createSafeInvocation(
    (event) => runHandler(depsFactory(), event),
    monotonicNow,
  );
}

export function createProductionHandler(
  depsFactory: () => ProductionHandlerDeps,
  monotonicNow: () => number = () => performance.now(),
) {
  return createSafeInvocation(
    (event) => runProductionHandler(depsFactory(), event),
    monotonicNow,
  );
}

const productionHandler = createProductionHandler(defaultDeps);
```

Extract the existing completion mapping into private `logScheduledCompletion` without changing its replay/reconcile/incremental count semantics. The deployed `handler` delegates to `productionHandler`. `defaultDeps` returns `ProductionHandlerDeps` and cannot populate `capabilityFreeObjectSource`.

- [ ] **Step 8: Keep the logger wrapper closed**

In `src/log.ts`, retain `suppression_object_invalid_aggregate` as the only package-level invalid-object operation. It accepts only:

```ts
{
  invalid_line_numbers: readonly number[];
  invalid_line_count: number;
}
```

The full production diagnostic policy remains private in `productionSuppressionWorkflow.ts`. Do not add a package-level full diagnostic method or any ordinary-string key/version/ETag/checksum method.

- [ ] **Step 9: Run focused GREEN tests**

Run:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm --prefix cloud/lambdas/suppression-sync run typecheck && npm --prefix cloud/lambdas/suppression-sync test -- --run test/productionSuppressionWorkflow.test.ts test/handler.test.ts test/replay.test.ts
```

Expected:

- typecheck exits 0
- all three test files pass
- production incremental has exactly one full `error` diagnostic
- production replay and reconciliation each have exactly one full `warn` diagnostic with their specified continue-or-fail behavior
- capability-free incremental, replay, and reconciliation each have exactly one aggregate-only diagnostic
- sequential incremental regression passes

If a test needs to import a private authority, reader, policy, client, descriptor reader, or diagnostic consumer, the architecture is wrong. Stop and redesign instead of exporting it.

- [ ] **Step 10: Run the complete fresh regression gate**

Run exactly:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; set -e; for p in shared adapter-boston-assessments adapter-boston-rentsmart adapter-pvd-taxroll enricher mail-parse resolver scorer suppression-sync; do npm --prefix "cloud/lambdas/$p" run typecheck; npm --prefix "cloud/lambdas/$p" test -- --run; done
```

Then run:

```bash
git diff --check
! git grep -nE 'productionSuppressionObjectSource|logSuppressionObjectDiagnostic|readProductionObject' -- cloud/lambdas/suppression-sync/src
! git grep -nE '\bdiagnosticLevel\b' -- cloud/lambdas/suppression-sync/src
```

Negative string assertions may name removed exports in tests. No production source file may retain a split production source, metadata consumer, production descriptor reader, or `diagnosticLevel` symbol.

Confirm:

- all nine package typechecks pass
- shared tests and all eight Lambda package tests pass
- no raw PII-bearing test fixture appears in console output
- no unexpected tracked file changed

- [ ] **Step 11: Review exact scope and commit**

Run:

```bash
git status --short
git diff --name-only
```

The changed path set must be exactly the eight declared files. Stage and commit only them:

```bash
git add \
  cloud/lambdas/suppression-sync/src/productionSuppressionWorkflow.ts \
  cloud/lambdas/suppression-sync/src/suppressionObject.ts \
  cloud/lambdas/suppression-sync/src/replay.ts \
  cloud/lambdas/suppression-sync/src/handler.ts \
  cloud/lambdas/suppression-sync/src/log.ts \
  cloud/lambdas/suppression-sync/test/productionSuppressionWorkflow.test.ts \
  cloud/lambdas/suppression-sync/test/handler.test.ts \
  cloud/lambdas/suppression-sync/test/replay.test.ts
git diff --cached --name-only
git commit -m "fix: seal suppression production acquisition"
```

After committing, rerun the focused suppression-sync typecheck/tests and `git diff --check HEAD^ HEAD`. Record the RED evidence, GREEN counts, full gate counts, exact commit hash, exact file list, and self-review in the SDD task report.

---

## Plan completion criteria

The implementation task is not complete until an independent scoped reviewer verifies:

1. No production descriptor is exposed between list and read.
2. No production diagnostic level is caller-controlled.
3. No production authority, reader, policy, consumer, or split source is exported or injectable.
4. Incremental, replay, and reconciliation production invalid objects each emit exactly one full diagnostic at the required mode-derived level.
5. Capability-free incremental, replay, and reconciliation invalid objects each emit exactly one aggregate-only diagnostic with the required fail-or-quarantine behavior.
6. Sequential incremental processing, ledger behavior, replay, reconciliation, scheduled completion, PII safety, and outward errors have no new Critical or Important regression.
7. The fresh Node 24 regression gate passes and the commit contains exactly the eight declared files.
