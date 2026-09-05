# Sealed Suppression Production Diagnostics Design

**Status:** Approved in chat, pending written-spec review

**Date:** 2026-09-05

**Product:** Callie Founder Sales System

## 1. Purpose

Replace the suppression-sync Lambda's split production `list` and `read` diagnostic boundary with a sealed production workflow. The workflow must preserve useful PII-safe object diagnostics without allowing injected wrappers or ordinary callers to consume, suppress, duplicate, downgrade, or redirect trusted metadata.

This design is a focused amendment to the approved Runtime, Recovery, and Security Hardening Design. All existing logging, compliance, schedule-disable, and outward-error requirements remain binding.

## 2. Why the current boundary is unsafe

The current implementation uses one structural `SuppressionObjectSource` interface for two different trust domains:

1. A production source that lists real S3 object versions, fetches exact bodies, creates opaque logging authority, and emits full diagnostics.
2. Injected sources used by tests and capability-free application paths.

The production source exposes separate `list` and `read` methods. It also accepts a diagnostic level during `read`. An injected wrapper can therefore call production `list`, pre-read a returned descriptor, consume one-shot metadata, substitute the level, and return the same descriptor to the intended flow. The intended read then emits a partial or wrong-level diagnostic.

A later guard attempted to avoid duplicate diagnostics by assuming every injected `objectSource` owned its logging. That assumption is false for ordinary capability-free fakes, so some invalid fake-source objects produce no diagnostic.

The root cause is not an individual missing check. It is the shared interface between trusted production acquisition and untrusted test injection.

## 3. Goals

1. Make the complete production list, fetch, hash, validate, and full-diagnostic sequence indivisible to ordinary callers.
2. Derive production diagnostic level internally from the execution mode.
3. Emit exactly one full authorized diagnostic for each invalid production object.
4. Emit exactly one aggregate-only diagnostic for each invalid capability-free injected object.
5. Preserve deterministic incremental, replay, quarantine, reconciliation, and ledger behavior.
6. Preserve the shared closed logging policy and all PII, secret, and contact-HMAC exclusions.
7. Preserve fixed outward `SafeHandlerError` behavior and scheduled completion logging.
8. Keep production schedules disabled and perform no AWS, provider, deployment, or live-data operation during implementation.

## 4. Non-goals

1. Changing suppression membership semantics, ledger keys, replay report formats, or reconciliation rules.
2. Expanding the shared logging field set.
3. Adding new CloudWatch alarms or changing Terraform. Those belong to Runtime Task 5.
4. Enabling schedules, invoking Lambda, or validating against live S3.
5. Generalizing the sealed production workflow for unrelated Lambda packages.

## 5. Trust model and invariants

### 5.1 Trusted production boundary

Only code that owns the real AWS SDK operation may authorize these full diagnostic fields:

- object key
- object version ID
- object ETag
- exact fetched-body SHA-256 checksum

The same sealed workflow must consume that authority before any failure or result becomes visible outside the boundary.

### 5.2 Capability-free core boundary

The reusable core may receive ordinary validated objects and ordinary `SuppressionObjectValidationError` values. It must never receive opaque log authority, production descriptor registrations, metadata readers, metadata consumers, or a caller-selected production diagnostic level.

### 5.3 Required invariants

1. No exported or injectable surface exposes a production descriptor between production list and production read.
2. No exported or injectable surface accepts a production diagnostic level.
3. No production metadata authority, policy, reader, serializer, or consumer is exported.
4. A production invalid object is fully diagnosed before a fresh capability-free error is exposed.
5. Re-reading or pre-reading a production descriptor is structurally impossible through public or injected APIs.
6. Injected source errors are always treated as capability-free and receive aggregate-only diagnostics.
7. Full production diagnostics contain only fields authorized by the existing closed logging policy.
8. Aggregate diagnostics contain only invalid line numbers, invalid line count, component, event code, level, and fixed safe error class when applicable.

## 6. Architecture

### 6.1 Separate the two trust domains

Production acquisition and injected acquisition will use different call graphs and different interfaces.

The production Lambda entry will call a sealed production loader that owns the real S3 lifecycle. The exported testable core will accept only a capability-free injected source or already loaded capability-free results. The production loader will never be placed in `HandlerDeps`.

### 6.2 Sealed production loader

Create the focused production module `cloud/lambdas/suppression-sync/src/productionSuppressionWorkflow.ts`.

It owns:

- a module-private AWS SDK S3 client
- real version listing and deterministic ordering
- exact-version object fetching
- whole-body UTF-8 materialization and hashing
- schema validation
- private metadata authority and readers
- the closed full-diagnostic serializer
- fixed execution-mode-to-level mapping

Its only module exports used by `handler.ts` are these atomic high-level operations:

```ts
iterateProductionIncrementalObjects(
  bucket: string,
  maxObjects?: number,
): AsyncIterable<ValidatedSuppressionObject>

loadProductionReplaySource(
  bucket: string,
): Promise<ProductionReplaySource>
```

`ProductionReplaySource` contains only ordinary validated objects, quarantine entries, deterministic evidence fields, and aggregates required by the shared replay core. It contains no opaque logging authority or callable diagnostic operation.

These contracts are binding:

- They do not accept an S3 client, response provider, object source, descriptor, log consumer, or diagnostic level.
- They do not return opaque authority or a callable diagnostic operation.
- They do not expose a descriptor before its exact body has been fetched and validated.
- The incremental async iterator yields one ordinary validated object at a time, so ledger and membership processing remain sequential. Objects completed before a later invalid object remain completed, matching current behavior.
- Incremental selection applies the parsed `maxObjects` limit before fetching or validating bodies, preserving current semantics.
- Incremental mode hard-codes full invalid diagnostics to `error` and fails after the first invalid selected object.
- Replay mode hard-codes full invalid diagnostics to `warn`, records quarantine evidence, and continues.
- Every invalid production object is diagnosed exactly once before a fresh capability-free error or quarantine record leaves the module.

No production descriptor input exists outside this module. A fabricated descriptor therefore cannot reach the private `GetObject` operation.

### 6.3 Capability-free injected source

Replace the current production-capable structural source with this exact capability-free interface. It remains in `HandlerDeps` under the property name `capabilityFreeObjectSource` for deterministic tests and pure core execution.

```ts
interface CapabilityFreeSuppressionObjectSource {
  list(bucket: string, prefix: string): Promise<readonly SuppressionObjectDescriptor[]>;
  read(descriptor: SuppressionObjectDescriptor): Promise<ValidatedSuppressionObject>;
}
```

The interface has no diagnostic-level parameter and cannot carry opaque log metadata. `defaultDeps` must not populate `capabilityFreeObjectSource`, and the production loader does not implement this split interface.

The capability-free call graph owns aggregate diagnostics:

- incremental invalid object: exactly one aggregate `error` diagnostic, then fail closed
- replay invalid object: exactly one aggregate `warn` diagnostic, quarantine, then continue

The decision to emit an aggregate diagnostic is based on using the capability-free call graph, not on a caller-provided boolean, brand, marker, or claimed ownership flag.

### 6.4 Shared processing core

Refactor incremental and replay processing so acquisition is completed before shared business processing begins.

The shared core owns:

- ledger lookups and marks
- monotonic suppression membership writes
- deterministic union construction
- quarantine and evidence aggregation from capability-free inputs
- reconciliation
- immutable report generation
- scheduled result aggregates

The core does not own production S3 diagnostics and cannot access trusted metadata authority.

Production flow:

```text
handler
  -> parse event
  -> sealed production loader with internally fixed mode
  -> capability-free validated objects or replay source
  -> shared processing core
  -> scheduled completion
```

Injected flow:

```text
createHandler/runHandler with capability-free deps
  -> capability-free list/read
  -> aggregate-only invalid diagnostic when needed
  -> shared processing core
  -> scheduled completion
```

### 6.5 Production entry and test entry

The deployed `handler` uses only the sealed production call graph for suppression object acquisition. It must not obtain the production loader through `HandlerDeps`, a factory callback, or another replaceable dependency.

`createHandler` and exported core helpers remain usable for deterministic tests, but they operate only on capability-free dependencies. A caller wrapping every exported test surface cannot gain access to the production loader's split list/read steps or its trusted metadata.

The deployed entry may still use ordinary dependencies for DynamoDB and report-writing operations. Those dependencies do not authorize full suppression-object log metadata.

## 7. Data flow

### 7.1 Production incremental

1. Parse and validate the incremental event.
2. The sealed loader lists real retained object versions and applies `maxObjects` before body fetches.
3. For each selected object, the sealed async iterator fetches the exact version, materializes its body, and yields only after successful validation.
4. The loader computes SHA-256 from the exact body and validates every nonblank row.
5. If invalid, the loader emits one full `error` diagnostic with authorized metadata, then throws a fresh capability-free validation error.
6. If valid, the iterator yields an ordinary validated object with no logging authority.
7. The shared core immediately checks the ledger, writes memberships monotonically, and marks the ledger before requesting the next object. A later invalid object does not undo an earlier completed object.
8. The exported boundary emits one scheduled completion and converts failures to a fixed `SafeHandlerError`.

### 7.2 Production replay

1. Parse and validate the explicit replay event.
2. The sealed loader lists every retained version in deterministic order.
3. Each version is fetched, hashed, and validated inside the sealed boundary.
4. Each invalid version emits one full `warn` diagnostic before an ordinary quarantine record is created.
5. Valid objects and capability-free quarantine evidence are returned to the shared replay core.
6. The core builds the deterministic source union, applies or dry-runs memberships, writes immutable evidence, and returns replay aggregates.
7. Scheduled completion reports valid-object count and quarantine count.

### 7.3 Capability-free injected paths

1. Tests or pure callers supply a capability-free source.
2. Invalid reads expose ordinary validation errors without authorized object metadata.
3. Incremental emits one aggregate `error` diagnostic and fails closed.
4. Replay emits one aggregate `warn` diagnostic, quarantines the object, and continues.
5. No key, version ID, ETag, checksum, row body, contact HMAC, or PII can enter the aggregate record.

## 8. Error handling

1. Full production diagnostic serialization happens before failure escapes the sealed loader.
2. The escaped error is newly constructed and contains no opaque token, metadata reader, diagnostic callback, cause, raw body, or provider error.
3. Capability-free injected failures never claim full production metadata.
4. Unexpected AWS, parsing, DynamoDB, or report-writing errors remain fail closed and are replaced at the exported boundary with the fixed safe outward error.
5. Every scheduled invocation still emits exactly one completion record in `finally`, including failures with safe zero defaults.
6. No raw exception message or cause is serialized.

## 9. File boundaries

Expected implementation scope:

- Create `cloud/lambdas/suppression-sync/src/productionSuppressionWorkflow.ts`
- Modify `cloud/lambdas/suppression-sync/src/suppressionObject.ts`
- Modify `cloud/lambdas/suppression-sync/src/replay.ts`
- Modify `cloud/lambdas/suppression-sync/src/handler.ts`
- Modify `cloud/lambdas/suppression-sync/src/log.ts`
- Modify `cloud/lambdas/suppression-sync/test/handler.test.ts`
- Modify `cloud/lambdas/suppression-sync/test/replay.test.ts`
- Create `cloud/lambdas/suppression-sync/test/productionSuppressionWorkflow.test.ts`

No shared logger, other Lambda package, Terraform, desktop application, domain schema, or live operational file is in scope unless typecheck produces a concrete required compatibility change. Any expansion must be ruled before editing.

## 10. Acceptance tests

### 10.1 Export and boundary tests

1. The production split source, production descriptor reader, metadata consumer, metadata policy, authorities, readers, and level-bearing production read are absent from exported/injectable surfaces.
2. `HandlerDeps` cannot accept the production loader.
3. No production acquisition API accepts an injected S3 client, response provider, descriptor, or diagnostic level.
4. Wrapping every exported test/core surface cannot observe an intermediate production descriptor or alter production diagnostic level.

### 10.2 Production incremental tests

Using an SDK-level mock of the module-private S3 client:

1. A real-list-shaped descriptor plus invalid fetched body emits exactly one full `error` diagnostic.
2. The record contains exact authorized key, version ID, normalized ETag, exact-body SHA-256, invalid line numbers, and invalid line count.
3. It contains no row body, contact HMAC, email, phone, credential, provider payload, raw error message, or cause.
4. No aggregate duplicate is emitted.
5. A valid first object is processed and ledgered before a later selected invalid object fails, preserving sequential incremental semantics.
6. The outward error is the fixed `SafeHandlerError`.

### 10.3 Production replay tests

1. An invalid retained version emits exactly one full `warn` diagnostic.
2. The object is quarantined and replay continues.
3. No `error`-level or aggregate duplicate diagnostic is emitted for that object.
4. Valid and quarantined counts retain existing replay semantics.

### 10.4 Capability-free injected tests

1. Incremental fake-source validation failure emits exactly one aggregate `error` diagnostic and no full metadata.
2. Replay fake-source validation failure emits exactly one aggregate `warn` diagnostic, quarantines, and continues.
3. Structural S3 test dependencies remain capability-free and satisfy the same aggregate-only rules.
4. A fake cannot opt out of aggregate logging through a marker, claimed ownership property, or source brand.

### 10.5 Regression gate

Run with the exact Node 24 prefix required by the parent plan:

- suppression-sync focused RED and GREEN tests
- suppression-sync typecheck and full tests
- shared package typecheck and tests
- all eight Lambda package typechecks and tests
- `git diff --check`
- export/symbol scans for removed unsafe surfaces
- exact committed-file scope check

No AWS, Lambda, Terraform, provider, deployment, Callie, Apple bridge, outreach, or live data operation is permitted.

## 11. Rollback

The change is code-only and schedules remain disabled. Rollback is the commit immediately before the sealed production workflow. No data migration or cloud state rollback is required.

The old split production source must not be restored as a partial rollback. If the new workflow cannot pass its production and capability-free diagnostic tests, keep schedules disabled and leave Task 4 incomplete.

## 12. Success criteria

The redesign is complete only when an independent reviewer verifies all of the following:

1. Production list and read cannot be intercepted separately.
2. Production diagnostic level is internal and mode-derived.
3. Incremental and replay production invalid objects each produce exactly one full diagnostic at the correct level.
4. Capability-free fake invalid objects each produce exactly one aggregate-only diagnostic.
5. No new Critical or Important logging, outward-error, replay, reconciliation, or scheduled-completion regression exists.
6. The fresh Node 24 regression gate passes.
