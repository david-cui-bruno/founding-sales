# Apple Communications Feasibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a signed, packageable, app-open Apple communications feasibility spike that proves or safely rejects CallKit observation, Contacts-gated identity classification, Phone Accessibility recording control, Notes artifact export, and Messages send/read paths without exposing native authority to the renderer or performing real communications in automated tests.

**Architecture:** Electron main owns a fixed-version TypeScript client and supervises one bundled Swift child process over newline-delimited JSON on stdio. Swift separates a Foundation-only protocol/core from macOS adapters; the production executable is inert until it receives an explicit typed command, fails closed on unresolved identity, writes exports only beneath a launch-time staging root, and exits with Callie. A CLI-gated renderer diagnostics panel exposes only enumerated feasibility actions, while automated tests use fakes and synthetic fixtures and all real calls/messages remain a separate consenting manual procedure.

**Tech Stack:** Electron 44, Electron Forge 7/Vite, Node.js 22.13+ or 24+, TypeScript 5.9, Zod 4, Vitest 2, Playwright 1.62, Swift 6/Swift Package Manager, Foundation, CallKit, Contacts, ApplicationServices Accessibility, AppKit/Apple Events, SQLite3, macOS codesign.

**Spec:** `docs/superpowers/specs/2026-08-30-founder-sales-system-v1-design.md`

## Global Constraints

- Initial Apple acceptance target is macOS 26.4 or newer on Apple silicon.
- V1 runs the helper only while Callie is open; it is a bundled child process, not a login item, launch agent, XPC service, or daemon.
- `CXCallObserver` supplies call state but not the remote phone number; outgoing Callie context may be known, while unresolved incoming identity must fail closed and must not auto-record.
- The unknown-number rule is enabled only with full Contacts access; limited, denied, restricted, and not-determined states cannot prove absence from Contacts.
- Phone recording automation is best effort. An Accessibility press is successful only after an independent state verification; missing, renamed, ambiguous, or disabled controls produce a visible failure.
- Apple transcript extraction is opportunistic. Audio discovery/export, Apple transcript extraction, cloud transcription, and manual transcript import have independent capability states.
- Messages history/delivery sync is read-only private-schema integration. Never write Apple's Messages database.
- The native bridge exposes no generic AppleScript, shell, SQL, filesystem path, or arbitrary Accessibility command.
- The renderer receives no filesystem, database, Keychain, shell, Accessibility, Apple Events, helper process, or raw bridge access.
- Automated tests must never place a call, send a message, prompt for TCC permission, read the founder's Contacts/Messages/Notes data, or use the normal Application Support workspace.
- Real calls and messages occur only in the documented manual procedure, against the founder's own secondary endpoint or a consenting test partner, after an explicit on-screen confirmation.
- Emergency numbers, short codes, voicemail, hidden/unresolved identities, and Never Record exclusions are fixture-only tests; never dial them for verification.
- Callie's managed staging directory is application-private mode `0700`; protocol requests use opaque artifact IDs and never caller-provided destination paths.
- The feasibility spike does not retain recording audio. It exports into staging, computes byte count and SHA-256, deletes the plaintext before returning proof, and removes abandoned staging files at helper startup and shutdown.
- Packaged builds accept no helper-path environment override. Development overrides are permitted only when `app.isPackaged === false`.
- Stable production bundle identifiers are `com.callie.foundersales` and `com.callie.foundersales.applebridge`.
- Stable-signature/TCC persistence claims require an Apple Development or Developer ID identity. Ad-hoc builds may prove function but not permission persistence across rebuilds.
- Capability failure degrades Apple integration only; it must not prevent the core local CRM from opening or closing cleanly.
- Every task follows RED -> verify RED -> GREEN -> verify GREEN -> refactor -> verify -> commit. Do not combine tasks before their reviewer gate.

---

## File Structure

### Cross-runtime contract

- `contracts/apple-bridge/v1/protocol.md` — normative JSONL envelope, method, event, error, privacy, and size rules.
- `contracts/apple-bridge/v1/fixtures/*.json` — non-sensitive golden messages decoded by both Swift and TypeScript tests.
- `src/shared/appleBridgeContract.ts` — Zod schemas and inferred TypeScript types matching protocol V1.

### Swift package

- `native/apple-bridge/Package.swift` — macOS 26.4 Swift package with protocol, core, macOS, and executable targets.
- `native/apple-bridge/Sources/CallieAppleProtocol/*` — Codable wire types and bounded JSONL codec.
- `native/apple-bridge/Sources/CallieAppleCore/*` — platform-neutral call/recording state, eligibility, ports, coordinator, and sanitized capabilities.
- `native/apple-bridge/Sources/CallieAppleMacOS/*` — concrete CallKit, Contacts, AX, Notes, Messages, permission, and read-only SQLite adapters.
- `native/apple-bridge/Sources/CallieAppleBridge/*` — stdio executable and production dependency composition.
- `native/apple-bridge/Resources/Helper-Info.plist` — nested helper bundle identity and TCC usage strings.
- `native/apple-bridge/Resources/CallieAppleBridge.entitlements` — Apple Events hardened-runtime entitlement.
- `native/apple-bridge/Tests/*` — side-effect-free Swift tests using fakes, AX snapshots, and synthetic databases.

### Electron main and renderer

- `src/main/appleBridge/appleBridgeProcess.ts` — child spawning abstraction, bounded line framing, stderr redaction, and termination.
- `src/main/appleBridge/appleBridgeClient.ts` — request correlation, versioned decoding, timeouts, and event subscription.
- `src/main/appleBridge/appleBridgeSupervisor.ts` — app-open helper lifecycle and degraded-state ownership.
- `src/main/appleBridge/helperPath.ts` — packaged/development helper resolution without packaged overrides.
- `src/main/appleBridge/verifyHelperSignature.ts` — fixed-path codesign verification for packaged launches.
- `src/main/appleBridge/appleSpikeService.ts` — enumerated, confirmation-gated feasibility actions.
- `src/main/appleBridge/registerAppleSpikeIpc.ts` — trusted-renderer IPC registration only.
- `src/shared/appleSpikeContract.ts` — sanitized status/action contract exposed through preload.
- `src/renderer/appleSpike/AppleSpikePanel.tsx` — CLI-gated manual diagnostics panel.
- `src/main/startApplication.ts` and `src/main.ts` — start degraded-safe supervisor and stop it before SQLite.
- `src/preload.ts` and `src/shared/preload.d.ts` — narrow feasibility API; no raw method dispatch.

### Build, package, tests, and procedure

- `build/appleBridge.ts` — build/bundle/copy hooks with dependency injection for tests.
- `scripts/buildAppleBridge.mjs` — Swift release build and nested `.app` assembly.
- `scripts/verifyAppleBridgePackage.mjs` — helper bundle, plist, architecture, signature, and entitlement verification.
- `forge.config.ts` — fixed host identifier, asset generation, helper copy, and per-file signing configuration.
- `scripts/verifyPackage.mjs` — invoke the helper verifier alongside existing app checks.
- `tests/fixtures/apple-bridge/fakeHelper.mjs` — inert JSONL helper used only by TypeScript tests.
- `tests/e2e/appleBridgeSmoke.spec.ts` — packaged handshake/capability/app-close smoke; no TCC prompts or communications.
- `docs/engineering/apple-feasibility-procedure.md` — consenting, dedicated-account manual test matrix and capability-specific fallbacks.

---

### Task 1: Lock Protocol V1 Across TypeScript and Swift

**Files:**
- Create: `contracts/apple-bridge/v1/protocol.md`
- Create: `contracts/apple-bridge/v1/fixtures/hello.request.json`
- Create: `contracts/apple-bridge/v1/fixtures/hello.response.json`
- Create: `contracts/apple-bridge/v1/fixtures/call-connected.event.json`
- Create: `contracts/apple-bridge/v1/fixtures/recording-failed.event.json`
- Create: `contracts/apple-bridge/v1/fixtures/error.response.json`
- Create: `src/shared/appleBridgeContract.ts`
- Create: `tests/main/appleBridgeContract.test.ts`
- Create: `native/apple-bridge/Package.swift`
- Create: `native/apple-bridge/Sources/CallieAppleProtocol/ProtocolVersion.swift`
- Create: `native/apple-bridge/Sources/CallieAppleProtocol/Envelope.swift`
- Create: `native/apple-bridge/Sources/CallieAppleProtocol/Commands.swift`
- Create: `native/apple-bridge/Sources/CallieAppleProtocol/Events.swift`
- Create: `native/apple-bridge/Sources/CallieAppleProtocol/Errors.swift`
- Create: `native/apple-bridge/Tests/CallieAppleProtocolTests/GoldenFixtureTests.swift`
- Modify: `package.json:11-25`

**Interfaces:**
- Consumes: no earlier task interfaces.
- Produces: `APPLE_BRIDGE_PROTOCOL_VERSION`, `bridgeRequestSchema`, `bridgeResponseSchema`, `bridgeEventSchema`, `BridgeRequest`, `BridgeResponse`, `BridgeEvent`, Swift `BridgeRequest`, `BridgeResponse`, `BridgeEvent`, `BridgeErrorPayload`, and the normative V1 method/event names.

- [ ] **Step 1: RED — write cross-runtime golden-contract tests**

```ts
// tests/main/appleBridgeContract.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPLE_BRIDGE_PROTOCOL_VERSION,
  bridgeEventSchema,
  bridgeRequestSchema,
  bridgeResponseSchema,
} from '../../src/shared/appleBridgeContract';

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      resolve('contracts/apple-bridge/v1/fixtures', name),
      'utf8',
    ),
  );

describe('Apple bridge protocol V1', () => {
  it('accepts only the committed request, response, and event fixtures', () => {
    expect(APPLE_BRIDGE_PROTOCOL_VERSION).toBe(1);
    expect(bridgeRequestSchema.parse(fixture('hello.request.json')).method).toBe(
      'bridge.hello',
    );
    expect(bridgeResponseSchema.parse(fixture('hello.response.json')).ok).toBe(true);
    expect(bridgeEventSchema.parse(fixture('call-connected.event.json')).event).toBe(
      'call.stateChanged',
    );
  });

  it('rejects arbitrary native commands and caller-provided paths', () => {
    expect(() =>
      bridgeRequestSchema.parse({
        v: 1,
        kind: 'request',
        id: crypto.randomUUID(),
        method: 'shell.execute',
        params: { path: '/tmp/output' },
      }),
    ).toThrow();
  });
});
```

```swift
// native/apple-bridge/Tests/CallieAppleProtocolTests/GoldenFixtureTests.swift
import Foundation
import Testing
@testable import CallieAppleProtocol

@Test func decodesGoldenHelloRequest() throws {
    let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    let data = try Data(contentsOf: root.appending(path: "contracts/apple-bridge/v1/fixtures/hello.request.json"))
    let request = try JSONDecoder().decode(BridgeRequest.self, from: data)
    #expect(request.v == 1)
    #expect(request.method == .hello)
}
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/appleBridgeContract.test.ts`

Expected: FAIL because `src/shared/appleBridgeContract.ts` and the fixtures do not exist.

Run: `swift test --package-path native/apple-bridge --filter GoldenFixtureTests`

Expected: FAIL because `native/apple-bridge/Package.swift` does not exist.

- [ ] **Step 3: GREEN — add strict protocol types and fixtures**

Use discriminated envelopes; do not use a free-form `method: string` in either runtime.

```ts
// src/shared/appleBridgeContract.ts
import { z } from 'zod';

export const APPLE_BRIDGE_PROTOCOL_VERSION = 1 as const;
const requestId = z.string().uuid();

const helloRequest = z.object({
  v: z.literal(1),
  kind: z.literal('request'),
  id: requestId,
  method: z.literal('bridge.hello'),
  params: z.object({ supportedVersions: z.tuple([z.literal(1)]) }).strict(),
}).strict();

const capabilityRequest = z.object({
  v: z.literal(1),
  kind: z.literal('request'),
  id: requestId,
  method: z.literal('capabilities.probe'),
  params: z.object({}).strict(),
}).strict();

export const bridgeRequestSchema = z.discriminatedUnion('method', [
  helloRequest,
  capabilityRequest,
]);

export const bridgeErrorCodeSchema = z.enum([
  'protocol_mismatch',
  'invalid_request',
  'permission_denied',
  'capability_unavailable',
  'identity_unresolved',
  'control_not_found',
  'recording_verification_failed',
  'artifact_not_found',
  'schema_unsupported',
  'timeout',
  'internal',
]);

export const bridgeResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    v: z.literal(1), kind: z.literal('response'), id: requestId,
    ok: z.literal(true), result: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    v: z.literal(1), kind: z.literal('response'), id: requestId,
    ok: z.literal(false),
    error: z.object({
      code: bridgeErrorCodeSchema,
      message: z.string().min(1).max(300),
      retryable: z.boolean(),
    }).strict(),
  }).strict(),
]);

export const bridgeEventSchema = z.object({
  v: z.literal(1), kind: z.literal('event'), seq: z.number().int().nonnegative(),
  event: z.enum([
    'bridge.ready', 'capability.changed', 'call.stateChanged',
    'call.identityResolved', 'call.identityUnresolved', 'recording.attempted',
    'recording.verified', 'recording.failed', 'notes.artifactDiscovered',
    'notes.exportCompleted', 'notes.transcriptUnavailable',
    'messages.activityObserved', 'bridge.warning',
  ]),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;
export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;
```

In Swift, encode method and event names as `String`-backed enums and define explicit payload structs for every method documented in `contracts/apple-bridge/v1/protocol.md`. Add all spike methods from Global Constraints now so subsequent tasks extend handlers, not the wire vocabulary.

The complete V1 method enum is:

```swift
public enum BridgeMethod: String, Codable, Sendable {
    case hello = "bridge.hello"
    case probeCapabilities = "capabilities.probe"
    case requestContacts = "permissions.requestContacts"
    case promptAccessibility = "permissions.promptAccessibility"
    case startCallObservation = "call.observe.start"
    case stopCallObservation = "call.observe.stop"
    case armOutgoingRecording = "recording.armOutgoing"
    case disarmRecording = "recording.disarm"
    case scanCallRecordings = "notes.scanCallRecordings"
    case exportCallRecording = "notes.exportCallRecording"
    case sendTestMessage = "messages.sendTest"
    case scanTestMessageActivity = "messages.scanTestActivity"
    case shutdown = "bridge.shutdown"
}
```

Commit these exact non-sensitive fixture bodies, using the same fixed request ID in request/response pairs:

```json
{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"bridge.hello","params":{"supportedVersions":[1]}}
```

```json
{"v":1,"kind":"response","id":"11111111-1111-4111-8111-111111111111","ok":true,"result":{"selectedVersion":1,"helperVersion":"0.1.0-test","bundleIdentifier":"com.callie.foundersales.applebridge","osVersion":"26.4","architecture":"arm64"}}
```

```json
{"v":1,"kind":"event","seq":1,"event":"call.stateChanged","payload":{"callId":"22222222-2222-4222-8222-222222222222","direction":"incoming","connected":true,"ended":false,"onHold":false,"observedAt":"2026-08-30T18:21:11.313Z"}}
```

```json
{"v":1,"kind":"event","seq":2,"event":"recording.failed","payload":{"callId":"22222222-2222-4222-8222-222222222222","code":"control_not_found","observedAt":"2026-08-30T18:21:12.313Z"}}
```

```json
{"v":1,"kind":"response","id":"11111111-1111-4111-8111-111111111111","ok":false,"error":{"code":"protocol_mismatch","message":"Protocol V1 handshake is required.","retryable":false}}
```

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/main/appleBridgeContract.test.ts && swift test --package-path native/apple-bridge --filter GoldenFixtureTests`

Expected: both suites PASS; both runtimes decode the same committed fixtures and reject `shell.execute`.

- [ ] **Step 5: Refactor — make fixture ownership and scripts explicit**

Add these scripts without changing existing command behavior:

```json
"test:swift": "swift test --package-path native/apple-bridge",
"build:swift": "swift build --package-path native/apple-bridge -c release --arch arm64"
```

Run: `npm run typecheck && npm run test:swift`

Expected: PASS with no production executable performing a system action.

- [ ] **Step 6: Commit**

```bash
git add contracts/apple-bridge native/apple-bridge/Package.swift native/apple-bridge/Sources/CallieAppleProtocol native/apple-bridge/Tests/CallieAppleProtocolTests src/shared/appleBridgeContract.ts tests/main/appleBridgeContract.test.ts package.json package-lock.json
git commit -m "feat: define Apple bridge protocol v1"
```

---

### Task 2: Build the Bounded Swift JSONL Server

**Files:**
- Create: `native/apple-bridge/Sources/CallieAppleProtocol/JSONLinesCodec.swift`
- Create: `native/apple-bridge/Sources/CallieAppleCore/BridgeCommandHandling.swift`
- Create: `native/apple-bridge/Sources/CallieAppleBridge/StdioBridgeServer.swift`
- Create: `native/apple-bridge/Sources/CallieAppleBridge/main.swift`
- Create: `native/apple-bridge/Tests/CallieAppleProtocolTests/JSONLinesCodecTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleCoreTests/StdioBridgeServerTests.swift`
- Modify: `native/apple-bridge/Package.swift`

**Interfaces:**
- Consumes: Task 1 `BridgeRequest`, `BridgeResponse`, `BridgeEvent`, and protocol V1 enums.
- Produces: `JSONLinesCodec(maxFrameBytes: Int = 262_144)`, `BridgeCommandHandling.handle(_:)`, and `StdioBridgeServer.run(input:output:errorOutput:)`.

- [ ] **Step 1: RED — test framing, handshake, and safe errors**

```swift
@Test func rejectsOversizedFrameWithoutDecoding() throws {
    let codec = JSONLinesCodec(maxFrameBytes: 8)
    #expect(throws: JSONLinesCodecError.frameTooLarge) {
        try codec.decodeLine(Data(repeating: 0x61, count: 9))
    }
}

@Test func serverRequiresHelloBeforeCapabilityProbe() async throws {
    let handler = FakeBridgeHandler()
    let server = StdioBridgeServer(handler: handler)
    let response = try await server.processLine(capabilityProbeFixture)
    #expect(response.error?.code == .protocolMismatch)
    #expect(handler.received.isEmpty)
}
```

- [ ] **Step 2: Verify RED**

Run: `swift test --package-path native/apple-bridge --filter JSONLinesCodecTests && swift test --package-path native/apple-bridge --filter StdioBridgeServerTests`

Expected: FAIL because codec and server types do not exist.

- [ ] **Step 3: GREEN — implement bounded line framing and handshake**

```swift
public struct JSONLinesCodec: Sendable {
    public let maxFrameBytes: Int

    public init(maxFrameBytes: Int = 262_144) {
        self.maxFrameBytes = maxFrameBytes
    }

    public func decodeLine(_ data: Data) throws -> BridgeRequest {
        guard data.count <= maxFrameBytes else { throw JSONLinesCodecError.frameTooLarge }
        guard String(data: data, encoding: .utf8) != nil else { throw JSONLinesCodecError.invalidUTF8 }
        return try JSONDecoder().decode(BridgeRequest.self, from: data)
    }

    public func encodeLine<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        let encoded = try encoder.encode(value)
        guard encoded.count <= maxFrameBytes else { throw JSONLinesCodecError.frameTooLarge }
        return encoded + Data([0x0A])
    }
}
```

The executable supports only `bridge.hello`, `capabilities.probe`, and `bridge.shutdown` in this task. `bridge.hello` must be the first accepted request, duplicate request IDs must return `invalid_request`, EOF must terminate cleanly, stdout must contain protocol frames only, and stderr must use constant messages without request payloads.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:swift && printf '%s\n' '{"v":1,"kind":"request","id":"11111111-1111-4111-8111-111111111111","method":"bridge.hello","params":{"supportedVersions":[1]}}' | swift run --package-path native/apple-bridge CallieAppleBridge`

Expected: Swift tests PASS and the executable emits exactly one `ok:true` V1 response followed by a newline; it performs no TCC or Apple operation.

- [ ] **Step 5: Refactor — isolate I/O from request processing**

Move per-line logic into `processLine(_:)` so tests never replace global stdin/stdout. Keep the executable composition in `main.swift` under 40 lines.

Run: `swift test --package-path native/apple-bridge`

Expected: PASS; JSON framing and command dispatch remain independently testable.

- [ ] **Step 6: Commit**

```bash
git add native/apple-bridge
git commit -m "feat: add bounded Apple bridge JSONL server"
```

---

### Task 3: Implement Fail-Closed Call and Recording Core

**Files:**
- Create: `native/apple-bridge/Sources/CallieAppleCore/Ports.swift`
- Create: `native/apple-bridge/Sources/CallieAppleCore/CapabilityStatus.swift`
- Create: `native/apple-bridge/Sources/CallieAppleCore/ObservedCall.swift`
- Create: `native/apple-bridge/Sources/CallieAppleCore/RecordingEligibility.swift`
- Create: `native/apple-bridge/Sources/CallieAppleCore/CallSessionStateMachine.swift`
- Create: `native/apple-bridge/Sources/CallieAppleCore/BridgeCoordinator.swift`
- Create: `native/apple-bridge/Tests/CallieAppleCoreTests/RecordingEligibilityTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleCoreTests/CallSessionStateMachineTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleCoreTests/BridgeCoordinatorTests.swift`
- Modify: `native/apple-bridge/Package.swift`

**Interfaces:**
- Consumes: Task 2 `BridgeCommandHandling`.
- Produces: `ObservedCall`, `ContactAccess`, `IdentityResolution`, `RecordingPolicySnapshot`, `RecordingDecision`, platform port protocols, `CallSessionStateMachine`, and `BridgeCoordinator`.

- [ ] **Step 1: RED — encode the safety boundary as tests**

```swift
@Test func unresolvedIncomingCallNeverRecords() {
    let decision = RecordingEligibility.evaluate(
        call: .init(id: UUID(), outgoing: false, connected: true, ended: false, onHold: false),
        identity: .unresolved,
        contactAccess: .full,
        policy: .fixtureAllowKnownAndUnknown
    )
    #expect(decision == .deny(.identityUnresolved))
}

@Test func limitedContactsCannotProveUnknown() {
    let decision = RecordingEligibility.evaluate(
        call: .connectedIncomingFixture,
        identity: .resolved(.fixtureHandle, contactMembership: .notFound),
        contactAccess: .limited,
        policy: .fixtureAllowKnownAndUnknown
    )
    #expect(decision == .deny(.fullContactsRequired))
}

@Test func attemptedRecordingIsNotVerifiedRecording() {
    var state = CallSessionStateMachine(call: .connectedOutgoingFixture)
    state.apply(.recordingAttempted(at: .fixture))
    #expect(state.recordingState == .attempted)
    state.apply(.recordingVerificationFailed(.controlNotFound))
    #expect(state.recordingState == .failed(.controlNotFound))
}
```

- [ ] **Step 2: Verify RED**

Run: `swift test --package-path native/apple-bridge --filter RecordingEligibilityTests && swift test --package-path native/apple-bridge --filter CallSessionStateMachineTests`

Expected: FAIL because core safety types do not exist.

- [ ] **Step 3: GREEN — implement explicit states and ports**

```swift
public struct ObservedCall: Sendable, Equatable {
    public let id: UUID
    public let outgoing: Bool
    public let connected: Bool
    public let ended: Bool
    public let onHold: Bool
}

public enum IdentityResolution: Sendable, Equatable {
    case resolved(NormalizedHandle, contactMembership: ContactMembership)
    case ambiguous
    case unresolved
}

public enum RecordingDecision: Sendable, Equatable {
    case allow(RecordingReason)
    case deny(RecordingDenial)
}

public protocol CallObserving: Sendable {
    func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws
    func stop()
}

public protocol RecordingControlling: Sendable {
    func attemptStart(for call: ObservedCall) async throws -> RecordingVerification
}
```

`RecordingEligibility.evaluate` must apply exclusions in this order: Never Record, emergency, short code, voicemail, unresolved/ambiguous identity, insufficient Contacts access for unknown classification, policy allow. The coordinator emits `recording.verified` only from `RecordingVerification.verified`; a button press or attempted state is never enough.

- [ ] **Step 4: Verify GREEN**

Run: `swift test --package-path native/apple-bridge --filter CallieAppleCoreTests`

Expected: PASS for known outgoing, safely resolved incoming, unresolved incoming, every Contacts state, Never Record, emergency/short-code/voicemail fixtures, duplicate state events, call end, and failed verification.

- [ ] **Step 5: Refactor — keep system frameworks out of core**

Run: `rg -n 'import (CallKit|Contacts|ApplicationServices|AppKit|SQLite3)' native/apple-bridge/Sources/CallieAppleCore`

Expected: no output.

Run: `npm run test:swift`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/apple-bridge/Sources/CallieAppleCore native/apple-bridge/Tests/CallieAppleCoreTests native/apple-bridge/Package.swift
git commit -m "feat: add fail-closed recording core"
```

---

### Task 4: Add CallKit, Contacts, Permission, and Phone AX Adapters

**Files:**
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/CallKitObserver.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/ContactsClassifier.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/PermissionProbe.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/AXNodeSnapshot.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/PhoneAccessibilityClient.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/PhoneRecordingController.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/ContactsClassifierTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/PhoneAccessibilityClientTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/phone-recording-available.json`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/phone-recording-missing.json`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/phone-recording-ambiguous.json`
- Modify: `native/apple-bridge/Package.swift`

**Interfaces:**
- Consumes: Task 3 `CallObserving`, `ObservedCall`, `ContactAccess`, `IdentityResolution`, `RecordingControlling`, and `RecordingVerification`.
- Produces: `CallKitObserver`, `ContactsClassifier`, `PermissionProbe`, `AXSnapshotting`, `PhoneAccessibilityClient`, and `PhoneRecordingController`.

- [ ] **Step 1: RED — test mapping and AX parsing with no live system access**

```swift
@Test func missingRecordingControlFailsWithoutPressingAnything() throws {
    let snapshot = try AXNodeSnapshot.fixture(named: "phone-recording-missing")
    let actuator = FakeAXActuator()
    let client = PhoneAccessibilityClient(snapshotter: FixedSnapshotter(snapshot), actuator: actuator)
    #expect(throws: PhoneAccessibilityError.controlNotFound) {
        try client.startAndVerifyRecording()
    }
    #expect(actuator.pressed.isEmpty)
}

@Test func limitedContactAccessReturnsUnavailableClassification() async throws {
    let store = FakeContactStore(access: .limited, membership: .notFound)
    let classifier = ContactsClassifier(store: store)
    #expect(await classifier.classify(.fixtureHandle) == .classificationUnavailable)
}
```

- [ ] **Step 2: Verify RED**

Run: `swift test --package-path native/apple-bridge --filter CallieAppleMacOSTests`

Expected: FAIL because the macOS adapters and fixtures do not exist.

- [ ] **Step 3: GREEN — map public call state and isolate private AX parsing**

```swift
final class CallKitObserver: NSObject, CallObserving, CXCallObserverDelegate, @unchecked Sendable {
    private let observer = CXCallObserver()
    private var sink: (@Sendable (ObservedCall) -> Void)?

    func start(_ sink: @escaping @Sendable (ObservedCall) -> Void) throws {
        self.sink = sink
        observer.setDelegate(self, queue: .main)
    }

    func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        sink?(ObservedCall(
            id: call.uuid,
            outgoing: call.isOutgoing,
            connected: call.hasConnected,
            ended: call.hasEnded,
            onHold: call.isOnHold
        ))
    }

    func stop() {
        observer.setDelegate(nil, queue: nil)
        sink = nil
    }
}
```

Do not add a remote-number property to `ObservedCall`. `PhoneAccessibilityClient` receives a detached `AXNodeSnapshot`, identifies exactly one enabled recording action from versioned role/title/identifier rules, presses through `AXActuating`, re-snapshots, and returns `.verified` only when the active-recording indicator is present. `PermissionProbe.probe()` never prompts; Contacts and Accessibility prompts live behind separate explicit commands.

- [ ] **Step 4: Verify GREEN**

Run: `swift test --package-path native/apple-bridge --filter CallieAppleMacOSTests && swift build --package-path native/apple-bridge`

Expected: PASS without a TCC prompt; the test target uses only fakes and committed AX snapshots.

- [ ] **Step 5: Refactor — prove tests contain no live selectors**

Inject `ContactStoreReading`, `AXSnapshotting`, and `AXActuating`; production wrappers are the only types allowed to call `CNContactStore`, `AXUIElementCopyAttributeValue`, or `AXUIElementPerformAction`.

Run: `rg -n 'CNContactStore|AXUIElement(Copy|Perform)' native/apple-bridge/Tests`

Expected: no output.

Run: `npm run test:swift`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/apple-bridge/Sources/CallieAppleMacOS native/apple-bridge/Tests/CallieAppleMacOSTests native/apple-bridge/Package.swift
git commit -m "feat: add testable macOS call adapters"
```

---

### Task 5: Add Safe Notes and Messages Feasibility Adapters

**Files:**
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/AppleEventExecuting.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/NotesRecordingLocator.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/NotesAttachmentExporter.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/MessagesScriptClient.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/MessagesReadStore.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/PathContainment.swift`
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/MacOSDependencyContainer.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/NotesAdapterTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/MessagesAdapterTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/PathContainmentTests.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/messages-v26.sql`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/messages-unsupported.sql`
- Modify: `native/apple-bridge/Sources/CallieAppleBridge/main.swift`

**Interfaces:**
- Consumes: Task 3 Notes/Messages ports and Task 2 server.
- Produces: opaque `NotesArtifactID`, `NotesRecordingLocator.scan(since:)`, `NotesAttachmentExporter.proveExport(id:)`, `MessagesScriptClient.sendTest(_:)`, `MessagesReadStore.scanTestActivity(handle:since:)`, and production dependency composition.

- [ ] **Step 1: RED — test path containment, read-only schema behavior, and confirmation**

```swift
@Test func artifactExportCannotEscapeStagingRoot() throws {
    let root = URL(fileURLWithPath: "/private/tmp/callie-spike", isDirectory: true)
    #expect(throws: PathContainmentError.escapeAttempt) {
        try PathContainment.resolve(relativeName: "../Messages/chat.db", under: root)
    }
}

@Test func unsupportedMessagesSchemaDegradesWithoutWriting() throws {
    let database = try SyntheticMessagesDatabase.fixture(named: "messages-unsupported")
    let store = MessagesReadStore(database: database)
    #expect(throws: MessagesReadError.schemaUnsupported) {
        try store.scanTestActivity(handle: .fixtureHandle, since: .fixture)
    }
    #expect(database.writeStatementCount == 0)
}

@Test func messageSendRequiresExactManualConfirmation() async throws {
    let executor = FakeAppleEventExecutor()
    let client = MessagesScriptClient(executor: executor)
    #expect(throws: MessagesSendError.manualConfirmationRequired) {
        try await client.sendTest(.fixture(confirmation: "yes"))
    }
    #expect(executor.events.isEmpty)
}
```

- [ ] **Step 2: Verify RED**

Run: `swift test --package-path native/apple-bridge --filter NotesAdapterTests && swift test --package-path native/apple-bridge --filter MessagesAdapterTests && swift test --package-path native/apple-bridge --filter PathContainmentTests`

Expected: FAIL because Notes, Messages, and containment adapters do not exist.

- [ ] **Step 3: GREEN — implement opaque exports and fixed Apple Events**

```swift
public struct ManualMessageTest: Sendable, Equatable {
    public static let requiredConfirmation = "I CONSENT TO THIS TEST MESSAGE"
    public let commandID: UUID
    public let handle: NormalizedHandle
    public let body: String
    public let confirmation: String
}

public struct ExportProof: Sendable, Equatable {
    public let artifactID: NotesArtifactID
    public let byteCount: Int64
    public let sha256: String
    public let plaintextRetained: Bool
}
```

Use fixed Apple Event operations whose target bundle IDs are constants. Values are passed as descriptors, never concatenated executable source. The Notes exporter owns one canonicalized `0700` staging root received at process launch and generates the filename itself. For this spike, `proveExport(id:)` exports, hashes, counts, deletes the plaintext, verifies the file is absent, and only then returns `ExportProof(plaintextRetained: false)`. Startup and shutdown remove abandoned files contained by that staging root. The Messages SQLite connection uses `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX`, applies a short busy timeout, validates the schema version/columns before selecting, and contains no INSERT, UPDATE, DELETE, REPLACE, PRAGMA-write, ATTACH, or VACUUM path.

Extend `BridgeCoordinator` handlers for `notes.scanCallRecordings`, `notes.exportCallRecording`, `messages.sendTest`, and `messages.scanTestActivity`. These methods remain inert until explicitly requested.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:swift`

Expected: PASS using synthetic fixtures; no test reads `~/Library`, opens Messages or Notes, or sends an Apple Event.

- [ ] **Step 5: Refactor — enforce no arbitrary command vocabulary**

Run: `rg -n 'Process\(|/bin/(sh|zsh|bash)|osascript|execute source|ATTACH|VACUUM|INSERT|UPDATE|DELETE|REPLACE' native/apple-bridge/Sources`

Expected: no shell execution and no Messages database write statements. A fixed in-process Apple Event implementation may contain named event constants but no protocol-provided script source.

Run: `swift test --package-path native/apple-bridge && swift build --package-path native/apple-bridge -c release --arch arm64`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/apple-bridge
git commit -m "feat: add safe Notes and Messages spike adapters"
```

---

### Task 6: Implement the TypeScript Bridge Process and Client

**Files:**
- Create: `src/main/appleBridge/helperPath.ts`
- Create: `src/main/appleBridge/verifyHelperSignature.ts`
- Create: `src/main/appleBridge/appleBridgeProcess.ts`
- Create: `src/main/appleBridge/appleBridgeClient.ts`
- Create: `tests/fixtures/apple-bridge/fakeHelper.mjs`
- Create: `tests/main/helperPath.test.ts`
- Create: `tests/main/verifyHelperSignature.test.ts`
- Create: `tests/main/appleBridgeProcess.test.ts`
- Create: `tests/main/appleBridgeClient.test.ts`

**Interfaces:**
- Consumes: Task 1 Zod contracts.
- Produces: `resolveAppleBridgeExecutable(options)`, `verifyHelperSignature(options)`, `AppleBridgeProcess`, `AppleBridgeClient.request(request, timeoutMs)`, `AppleBridgeClient.subscribe(listener)`, and `AppleBridgeClient.shutdown()`.

- [ ] **Step 1: RED — test framing, timeout, packaged path, and non-retry behavior**

```ts
it('ignores packaged helper override and resolves only inside Contents/Helpers', () => {
  expect(resolveAppleBridgeExecutable({
    isPackaged: true,
    resourcesPath: '/Applications/Callie.app/Contents/Resources',
    environment: { CALLIE_APPLE_BRIDGE_PATH: '/tmp/attacker' },
  })).toBe(
    '/Applications/Callie.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge',
  );
});

it('does not retry an ambiguous manual message send', async () => {
  const process = new FakeBridgeProcess();
  const client = new AppleBridgeClient(process);
  const pending = client.request(manualMessageRequest, 50);
  process.exit(1);
  await expect(pending).rejects.toThrow('exited');
  expect(process.writes).toHaveLength(1);
});

it('rejects a packaged helper with the wrong identifier before spawn', async () => {
  const run = vi.fn(async () => ({
    identifier: 'com.attacker.helper',
    teamIdentifier: 'TEAM123456',
  }));
  await expect(verifyHelperSignature({
    executablePath: packagedHelperPath,
    expectedIdentifier: 'com.callie.foundersales.applebridge',
    expectedTeamIdentifier: 'TEAM123456',
    run,
  })).rejects.toThrow('identifier');
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/helperPath.test.ts tests/main/verifyHelperSignature.test.ts tests/main/appleBridgeProcess.test.ts tests/main/appleBridgeClient.test.ts`

Expected: FAIL because the bridge process/client modules do not exist.

- [ ] **Step 3: GREEN — spawn without a shell and parse bounded frames**

```ts
export type AppleBridgeClientApi = {
  request<T extends BridgeRequest>(request: T, timeoutMs?: number): Promise<BridgeResponse>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  shutdown(): Promise<void>;
};

export const spawnAppleBridge = (
  executablePath: string,
  stagingRoot: string,
  spawnProcess = spawn,
): ChildProcessWithoutNullStreams =>
  spawnProcess(executablePath, ['--staging-root', stagingRoot], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
    },
  });
```

`AppleBridgeProcess` must reject stdout lines over 262,144 bytes before JSON parsing, cap retained stderr at 32 KiB, redact phone/email/path-shaped values, and treat stderr as diagnostics only. `AppleBridgeClient` validates every frame with Zod, requires hello within three seconds, rejects duplicate/unknown response IDs, never retries side-effecting requests, and removes timers/listeners when requests settle.

`verifyHelperSignature` uses `execFile`, never a shell, with fixed `/usr/bin/codesign` arguments. It runs strict verification, extracts identifier and Team ID, compares both with compiled expectations in packaged mode, and permits an explicit unsigned development result only when `isPackaged === false`. The supervisor must call it before spawning the packaged helper.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/main/helperPath.test.ts tests/main/verifyHelperSignature.test.ts tests/main/appleBridgeProcess.test.ts tests/main/appleBridgeClient.test.ts`

Expected: PASS for split/coalesced lines, malformed JSON, oversized frames, handshake mismatch/timeout, unknown events, process exit, shutdown, packaged override rejection, and exactly-one write for a manual send.

- [ ] **Step 5: Refactor — prove the fake helper is the only test executable**

Run: `rg -n 'spawn\(|exec(File)?\(' tests/main tests/integration`

Expected: only the explicitly injected fake-helper harness appears; no test launches Phone, Messages, Notes, `tel:`, `open`, or `osascript`.

Run: `npm run typecheck && npx vitest run tests/main/appleBridge*.test.ts tests/main/helperPath.test.ts tests/main/verifyHelperSignature.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/appleBridge tests/fixtures/apple-bridge tests/main/helperPath.test.ts tests/main/verifyHelperSignature.test.ts tests/main/appleBridgeProcess.test.ts tests/main/appleBridgeClient.test.ts
git commit -m "feat: add Electron Apple bridge client"
```

---

### Task 7: Supervise the Helper Without Blocking Core Startup

**Files:**
- Create: `src/main/appleBridge/appleBridgeSupervisor.ts`
- Create: `src/main/appleBridge/appleBridgeService.ts`
- Create: `tests/main/appleBridgeSupervisor.test.ts`
- Create: `tests/integration/appleBridgeStartup.test.ts`
- Modify: `src/main/startApplication.ts:10-116`
- Modify: `src/main.ts:21-194`
- Modify: `tests/main/startApplication.test.ts`
- Modify: `tests/main/main.test.ts`

**Interfaces:**
- Consumes: Task 6 client/process/path APIs.
- Produces: `AppleBridgeSupervisor.start()`, `getStatus()`, `stop()`, `AppleBridgeService`, `ApplicationStartupDependencies.createAppleBridgeSupervisor`, and `ApplicationStartupOptions.appleBridge`.

- [ ] **Step 1: RED — test degraded startup and shutdown ordering**

```ts
it('opens core CRM when the helper cannot start', async () => {
  const supervisor = fakeSupervisor({ startError: new Error('missing helper') });
  const createWindow = vi.fn();
  const app = await startApplication(options({ createWindow }), dependencies({ supervisor }));
  expect(createWindow).toHaveBeenCalledOnce();
  expect(supervisor.getStatus()).toMatchObject({ state: 'degraded' });
  await app.shutdown();
});

it('stops the helper before closing SQLite', async () => {
  const order: string[] = [];
  const app = await startApplication(
    options(),
    dependencies({
      supervisor: fakeSupervisor({ onStop: () => order.push('helper') }),
      onCloseDatabase: () => order.push('database'),
    }),
  );
  await app.shutdown();
  expect(order).toEqual(['helper', 'database']);
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/appleBridgeSupervisor.test.ts tests/integration/appleBridgeStartup.test.ts tests/main/startApplication.test.ts tests/main/main.test.ts`

Expected: FAIL because startup has no supervisor dependency or status.

- [ ] **Step 3: GREEN — add app-open lifecycle with degraded status**

```ts
export type AppleBridgeStatus =
  | { state: 'disabled'; reason: 'unsupported_platform' | 'not_packaged_or_configured' }
  | { state: 'starting' }
  | { state: 'ready'; helperVersion: string; protocolVersion: 1 }
  | { state: 'degraded'; code: string; message: string };

export interface AppleBridgeSupervisor {
  start(): Promise<void>;
  getStatus(): AppleBridgeStatus;
  stop(): Promise<void>;
}
```

Create staging with `mkdir(stagingRoot, { recursive: true, mode: 0o700 })` and verify its mode before launch. Start the supervisor after FoundationRuntime initializes and before the renderer window loads. Convert every helper error into sanitized degraded status. During shutdown, unregister bridge IPC, call `supervisor.stop()`, and only then shut down FoundationRuntime; aggregate cleanup errors using the existing pattern.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/main/appleBridgeSupervisor.test.ts tests/integration/appleBridgeStartup.test.ts tests/main/startApplication.test.ts tests/main/main.test.ts`

Expected: PASS; missing/crashed/mismatched helper never blocks the window, and helper stop precedes database close.

- [ ] **Step 5: Refactor — make unsupported platforms explicit**

Windows/Linux test fixtures must return `disabled: unsupported_platform` without resolving or spawning a helper. macOS development without a configured helper returns `disabled: not_packaged_or_configured`.

Run: `npm run typecheck && npm run test -- --run tests/main/appleBridgeSupervisor.test.ts tests/integration/appleBridgeStartup.test.ts tests/main/startApplication.test.ts tests/main/main.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/main/startApplication.ts src/main/appleBridge/appleBridgeSupervisor.ts src/main/appleBridge/appleBridgeService.ts tests/main/appleBridgeSupervisor.test.ts tests/integration/appleBridgeStartup.test.ts tests/main/startApplication.test.ts tests/main/main.test.ts
git commit -m "feat: supervise app-open Apple helper"
```

---

### Task 8: Add a CLI-Gated, Confirmation-Gated Spike Panel

**Files:**
- Create: `src/shared/appleSpikeContract.ts`
- Create: `src/main/appleBridge/appleSpikeService.ts`
- Create: `src/main/appleBridge/registerAppleSpikeIpc.ts`
- Create: `src/renderer/appleSpike/AppleSpikePanel.tsx`
- Create: `src/renderer/appleSpike/AppleSpikePanel.test.tsx`
- Create: `tests/main/registerAppleSpikeIpc.test.ts`
- Create: `tests/main/appleSpikeService.test.ts`
- Create: `tests/integration/appleSpikePreload.test.ts`
- Modify: `src/preload.ts:1-10`
- Modify: `src/shared/preload.d.ts:1-15`
- Modify: `src/renderer/App.tsx:1-112`
- Modify: `src/renderer/App.test.tsx`
- Modify: `src/main.ts:21-194`
- Modify: `src/main/startApplication.ts:10-116`

**Interfaces:**
- Consumes: Task 7 `AppleBridgeService` and sanitized status.
- Produces: `appleSpikeStatusSchema`, `appleSpikeActionSchema`, `AppleSpikeService.getStatus()`, `requestPermission()`, `runReadOnlyCheck()`, `authorizeManualAction()`, IPC channels, and `window.callie.appleSpike`.

- [ ] **Step 1: RED — test disabled-by-default and exact confirmation**

```ts
it('does not expose side-effecting actions when the CLI gate is off', async () => {
  const service = new AppleSpikeService({ enabled: false, bridge: fakeBridge() });
  await expect(
    service.authorizeManualAction({
      action: 'send_test_message',
      confirmation: 'I CONSENT TO THIS TEST MESSAGE',
    }),
  ).rejects.toThrow('disabled');
});

it('requires the exact action-specific confirmation', async () => {
  const bridge = fakeBridge();
  const service = new AppleSpikeService({ enabled: true, bridge });
  await expect(
    service.authorizeManualAction({ action: 'send_test_message', confirmation: 'yes' }),
  ).rejects.toThrow('confirmation');
  expect(bridge.request).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run tests/main/appleSpikeService.test.ts tests/main/registerAppleSpikeIpc.test.ts tests/integration/appleSpikePreload.test.ts src/renderer/appleSpike/AppleSpikePanel.test.tsx`

Expected: FAIL because the spike contracts, service, IPC, preload API, and panel do not exist.

- [ ] **Step 3: GREEN — expose only enumerated actions**

```ts
export const appleSpikeActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('probe_capabilities') }).strict(),
  z.object({ action: z.literal('request_contacts') }).strict(),
  z.object({ action: z.literal('prompt_accessibility') }).strict(),
  z.object({ action: z.literal('scan_notes_since'), since: z.string().datetime() }).strict(),
  z.object({ action: z.literal('scan_test_messages'), since: z.string().datetime() }).strict(),
  z.object({
    action: z.literal('arm_test_call'),
    normalizedHandle: z.string().regex(/^\+[1-9]\d{7,14}$/),
    confirmation: z.literal('I CONSENT TO THIS TEST CALL'),
  }).strict(),
  z.object({
    action: z.literal('send_test_message'),
    normalizedHandle: z.string().regex(/^\+[1-9]\d{7,14}$/),
    body: z.string().min(1).max(500),
    confirmation: z.literal('I CONSENT TO THIS TEST MESSAGE'),
  }).strict(),
]);
```

The renderer never supplies bridge method names, artifact paths, AppleScript, SQL, or AX selectors. `registerAppleSpikeIpc` validates the sender using `validateSender`, rejects extra arguments, parses both requests and responses, and registers even when disabled so callers receive a typed disabled status. The panel renders only when `app.commandLine.hasSwitch('apple-feasibility-spike')` is true, separates read-only checks from manual actions, displays consent copy, and requires the founder to type the exact phrase before enabling the final button.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run tests/main/appleSpikeService.test.ts tests/main/registerAppleSpikeIpc.test.ts tests/integration/appleSpikePreload.test.ts src/renderer/appleSpike/AppleSpikePanel.test.tsx src/renderer/App.test.tsx`

Expected: PASS; fakes record no native request when disabled, malformed, untrusted, or incorrectly confirmed.

- [ ] **Step 5: Refactor — scan preload and IPC for raw authority**

Run: `rg -n 'method|shell|appleScript|sql|path|accessibility|artifactPath' src/preload.ts src/shared/preload.d.ts src/main/appleBridge/registerAppleSpikeIpc.ts src/renderer/appleSpike`

Expected: no raw bridge dispatcher or caller-provided native command/path field.

Run: `npm run typecheck && npm run lint && npx vitest run tests/main/appleSpikeService.test.ts tests/main/registerAppleSpikeIpc.test.ts tests/integration/appleSpikePreload.test.ts src/renderer/appleSpike/AppleSpikePanel.test.tsx src/renderer/App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/main/startApplication.ts src/main/appleBridge/appleSpikeService.ts src/main/appleBridge/registerAppleSpikeIpc.ts src/shared/appleSpikeContract.ts src/preload.ts src/shared/preload.d.ts src/renderer/App.tsx src/renderer/App.test.tsx src/renderer/appleSpike tests/main/appleSpikeService.test.ts tests/main/registerAppleSpikeIpc.test.ts tests/integration/appleSpikePreload.test.ts
git commit -m "feat: add gated Apple feasibility panel"
```

---

### Task 9: Build and Embed the Signed Nested Helper Bundle

**Files:**
- Create: `native/apple-bridge/Resources/Helper-Info.plist`
- Create: `native/apple-bridge/Resources/CallieAppleBridge.entitlements`
- Create: `build/appleBridge.ts`
- Create: `scripts/buildAppleBridge.mjs`
- Create: `test/appleBridgeBuild.test.mjs`
- Modify: `forge.config.ts:1-98`
- Modify: `package.json:11-25`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: Task 5 release executable.
- Produces: `buildAppleBridgeBundle(options)`, `copyAppleBridgeBundle(buildPath, sourceBundle)`, generated `build/generated/apple-bridge/Callie Apple Bridge.app`, and packaged nested helper path.

- [ ] **Step 1: RED — test deterministic bundle assembly and safe destination**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppleBridgeBundle } from '../scripts/buildAppleBridge.mjs';

test('assembles the generated helper deterministically', async () => {
  const commands = [];
  const result = await buildAppleBridgeBundle({
    projectRoot: '/repo',
    platform: 'darwin',
    arch: 'arm64',
    run: async (command) => commands.push(command),
    fileSystem: fakeFileSystem(),
  });
  assert.equal(result.bundlePath,
    '/repo/build/generated/apple-bridge/Callie Apple Bridge.app',
  );
  assert.equal(commands[0].command, 'swift');
  assert.ok(commands[0].args.includes('build'));
  assert.ok(commands[0].args.includes('--arch'));
  assert.ok(commands[0].args.includes('arm64'));
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/appleBridgeBuild.test.mjs`

Expected: FAIL because `build/appleBridge.ts` and `scripts/buildAppleBridge.mjs` do not exist.

- [ ] **Step 3: GREEN — assemble before signing and copy before package finalization**

`Helper-Info.plist` must contain:

```xml
<key>CFBundleIdentifier</key><string>com.callie.foundersales.applebridge</string>
<key>CFBundleExecutable</key><string>CallieAppleBridge</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>26.4</string>
<key>NSContactsUsageDescription</key><string>Callie checks whether a test caller is already in Contacts before deciding whether recording is eligible.</string>
<key>NSAppleEventsUsageDescription</key><string>Callie uses Apple Events only for founder-confirmed Messages tests and Notes recording export.</string>
```

`CallieAppleBridge.entitlements` contains only:

```xml
<key>com.apple.security.automation.apple-events</key><true/>
```

Set `packagerConfig.appBundleId` to `com.callie.foundersales`. Add a Forge `generateAssets` hook that runs the build script on Darwin arm64. In `packageAfterCopy`, copy the generated helper to `resolve(buildPath, '../..', 'Helpers', 'Callie Apple Bridge.app')` before packaging signs the bundle, then apply existing Electron fuses. Keep ad-hoc behavior for local functional builds; configure `osxSign.optionsForFile` so a configured stable identity applies helper entitlements to the helper executable.

Use this signing shape, with the identity supplied by the build environment rather than committed:

```ts
const signingIdentity = process.env.CALLIE_MAC_SIGN_IDENTITY;
packagerConfig: {
  appBundleId: 'com.callie.foundersales',
  osxSign: signingIdentity === undefined ? undefined : {
    identity: signingIdentity,
    hardenedRuntime: true,
    optionsForFile: (filePath) =>
      filePath.includes('Callie Apple Bridge.app')
        ? { entitlements: 'native/apple-bridge/Resources/CallieAppleBridge.entitlements' }
        : {},
  },
}
```

For the existing ad-hoc branch, sign the nested helper executable first with `codesign --force --sign - --entitlements native/apple-bridge/Resources/CallieAppleBridge.entitlements`, then perform the existing final deep parent signature while preserving entitlements. This makes the same package verifier meaningful for ad-hoc and stable-signed builds.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/appleBridgeBuild.test.mjs && npm run build:swift && npm run package`

Expected: tests PASS and this executable exists and is arm64:

```text
out/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge
```

Run: `file "out/Callie Founder Sales System-darwin-arm64/Callie Founder Sales System.app/Contents/Helpers/Callie Apple Bridge.app/Contents/MacOS/CallieAppleBridge"`

Expected: output contains `Mach-O 64-bit executable arm64`.

- [ ] **Step 5: Refactor — prevent generated artifacts from entering Git**

Add these ignore entries:

```text
native/apple-bridge/.build/
build/generated/
```

Run: `git status --short`

Expected: no generated Swift build or nested helper bundle appears.

Run: `npm run typecheck && npm run lint && node --test test/appleBridgeBuild.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add native/apple-bridge/Resources build/appleBridge.ts scripts/buildAppleBridge.mjs test/appleBridgeBuild.test.mjs forge.config.ts package.json package-lock.json .gitignore
git commit -m "build: package signed Apple helper bundle"
```

---

### Task 10: Verify the Packaged Helper and Side-Effect-Free Packaged Smoke

**Files:**
- Create: `scripts/verifyAppleBridgePackage.mjs`
- Create: `test/verifyAppleBridgePackage.test.mjs`
- Create: `tests/e2e/appleBridgeSmoke.spec.ts`
- Modify: `scripts/verifyPackage.mjs:1-414`
- Modify: `test/verifyPackage.test.mjs`
- Modify: `tests/support/packagedApplication.ts`
- Modify: `package.json:11-25`
- Modify: `README.md:1-75`

**Interfaces:**
- Consumes: Task 9 packaged helper and Task 8 gated status API.
- Produces: `verifyAppleBridgePackage(appPath, options)`, package report `appleBridge`, `test:e2e:apple`, and a packaged no-side-effect smoke test.

- [ ] **Step 1: RED — require helper identity, architecture, entitlement, and lifecycle**

```js
it('rejects a helper whose Team ID differs from the parent', () => {
  const fixture = packagedHelperFixture({ parentTeam: 'TEAMAAAA', helperTeam: 'TEAMBBBB' });
  expect(() => verifyAppleBridgePackage(fixture.appPath, fixture.options)).toThrow(
    /Team ID/i,
  );
});

it('rejects a helper missing the Apple Events entitlement', () => {
  const fixture = packagedHelperFixture({ automationEntitlement: false });
  expect(() => verifyAppleBridgePackage(fixture.appPath, fixture.options)).toThrow(
    /automation.apple-events/i,
  );
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/verifyAppleBridgePackage.test.mjs`

Expected: FAIL because the helper package verifier does not exist.

- [ ] **Step 3: GREEN — extend package verification and add inert E2E**

The verifier must inspect:

```js
export const expectedAppleBridge = {
  relativeBundle: 'Contents/Helpers/Callie Apple Bridge.app',
  executable: 'Contents/MacOS/CallieAppleBridge',
  bundleIdentifier: 'com.callie.foundersales.applebridge',
  minimumSystemVersion: '26.4',
  requiredEntitlement: 'com.apple.security.automation.apple-events',
};
```

Use fixed `execFileSync` commands for `file`, `plutil`, and `codesign`; parse the designated identifiers/Team IDs and require a strict nested signature. Ad-hoc builds report `signatureMode: 'adhoc'` and skip only Team-ID equality because no Team ID exists; they still require strict signature validity and the entitlement. A configured stable-signature build requires equal non-empty Team IDs.

`tests/e2e/appleBridgeSmoke.spec.ts` launches the packaged executable with a temporary `--user-data-dir`, `--remote-debugging-port`, and `--apple-feasibility-spike`. It asserts helper status becomes ready or a precise no-permission degraded state, no permission dialog is triggered by startup, no manual-action button is clicked, and terminating Callie terminates the helper. Extend `tests/support/packagedApplication.ts` with a PID-child wait helper that inspects only the packaged test process tree.

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/verifyAppleBridgePackage.test.mjs test/verifyPackage.test.mjs && npm run verify:package`

Expected: PASS and the JSON package report contains `appleBridge.bundleIdentifier`, `appleBridge.architecture`, `appleBridge.signatureMode`, and `appleBridge.automationEntitlement`.

Run: `npm run package && npx playwright test tests/e2e/appleBridgeSmoke.spec.ts`

Expected: PASS without placing a call, sending a message, prompting for Contacts/Accessibility/Automation, or reading the user's Apple databases.

- [ ] **Step 5: Refactor — make the standard E2E command include both suites**

Set:

```json
"test:e2e": "playwright test tests/e2e/foundation.spec.ts tests/e2e/appleBridgeSmoke.spec.ts"
```

Update README verification text to state that the Apple smoke test proves only packaging, handshake, degraded-state reporting, and app-close cleanup; it does not prove TCC grants or live communication.

Run: `npm run verify && npm run verify:e2e && npm run verify:package`

Expected: all TypeScript, lint, Vitest, packaged foundation, inert Apple smoke, and package verification checks PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/verifyAppleBridgePackage.mjs scripts/verifyPackage.mjs test/verifyAppleBridgePackage.test.mjs test/verifyPackage.test.mjs tests/e2e/appleBridgeSmoke.spec.ts tests/support/packagedApplication.ts package.json package-lock.json README.md
git commit -m "test: verify packaged Apple helper"
```

---

### Task 11: Publish and Guard the Consenting Manual Feasibility Procedure

**Files:**
- Create: `docs/engineering/apple-feasibility-procedure.md`
- Create: `test/appleFeasibilityDocumentation.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 8 gated panel, Task 9 packaged helper, Task 10 package verifier.
- Produces: a fixed manual runbook with setup, TCC attribution checks, safe call/message matrix, evidence fields, and capability-specific fallback decisions.

- [ ] **Step 1: RED — require every safety boundary in the runbook**

```js
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const procedure = readFileSync('docs/engineering/apple-feasibility-procedure.md', 'utf8');

test('manual Apple procedure contains consent and fixture-only exclusions', () => {
  for (const phrase of [
    'dedicated macOS test user',
    'I CONSENT TO THIS TEST CALL',
    'I CONSENT TO THIS TEST MESSAGE',
    'Never dial emergency numbers, short codes, or voicemail for this test',
    'App closed',
    'Limited Contacts',
    'Mac-to-iPhone handoff',
    'manual recording export/import',
  ]) {
    assert.match(procedure, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test test/appleFeasibilityDocumentation.test.mjs`

Expected: FAIL because the manual procedure does not exist.

- [ ] **Step 3: GREEN — write the exact manual procedure**

The runbook must contain these sections and commands:

```markdown
## Preconditions
- Dedicated macOS test user on macOS 26.4+ Apple silicon.
- Own secondary line or named consenting test partner.
- Stable-signed packaged build with bundle IDs recorded.
- No real leads loaded in the isolated `--user-data-dir` profile.

## Preflight verification
codesign --verify --deep --strict --verbose=4 "/absolute/path/Callie Founder Sales System.app"
codesign -dv --verbose=4 "/absolute/path/Callie Founder Sales System.app/Contents/Helpers/Callie Apple Bridge.app"
codesign -d --entitlements :- "/absolute/path/Callie Founder Sales System.app/Contents/Helpers/Callie Apple Bridge.app"

## Permission sequence
1. Launch with `--apple-feasibility-spike` and verify no prompt on startup.
2. Exercise Contacts denied, limited, then full states through explicit controls.
3. Grant Accessibility only after pressing the explicit prompt button.
4. Trigger one confirmed test Messages operation and record Automation attribution.
5. Trigger one Notes scan/export and record Automation attribution.
6. Grant Full Disk Access manually to the responsible signed bundle proven by the package.

## Fixture-only exclusions
Never dial emergency numbers, short codes, or voicemail for this test. Test these exclusions only in committed unit fixtures.
```

Add a table with these exact manual rows and expected outcomes: app closed, outgoing Callie test call, known consenting incoming caller, safely classified unknown consenting caller, Limited Contacts, hidden/unresolved identity, Never Record synthetic person, declined call, unanswered call, answer on Mac, answer only on iPhone, Mac-to-iPhone handoff, Notes audio export, transcript present, transcript unavailable, iCloud Notes unavailable, duplicate artifact scan, iMessage test, SMS/RCS only when a consenting endpoint is available, Messages Full Disk Access revoked, helper crash, and permission revoked mid-call.

For every row, record only timestamp, OS build, app/helper version, permission state, capability result, sanitized error code, and artifact hash/byte count. Verify that the isolated staging directory is empty after an export proof and after app quit. Never record a phone number, contact name, message body, transcript, or recording in the repository.

End with this decision table:

```markdown
| Failed capability | V1 fallback |
|---|---|
| Phone AX start/verify | Manual Apple recording tap |
| Notes discovery/export | Manual recording export/import |
| Apple transcript extraction | Founder-authorized cloud STT or manual transcript |
| Messages history read | Send-only plus manual activity logging |
| Incoming identity resolution | No auto-record for that call |
| Mac-to-iPhone recording continuity | Manual iPhone tap and ingest when artifact reaches Mac |
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test test/appleFeasibilityDocumentation.test.mjs`

Expected: PASS; the procedure contains the consent gates, dedicated-account restriction, safe matrix, evidence minimization, and every fallback.

- [ ] **Step 5: Refactor — link the procedure and run complete non-manual verification**

Add a README link titled `Apple communications manual feasibility procedure` and state that it is never run by `npm test`, `npm run verify`, `npm run verify:e2e`, or CI.

Run: `npm run test:swift && npm run verify && npm run verify:e2e && npm run verify:package && node --test test/appleFeasibilityDocumentation.test.mjs`

Expected: every automated check PASS with no real communication or TCC prompt.

Run: `git status --short`

Expected: only intended source, test, contract, build, and documentation changes are present; no Apple data, recording, transcript, generated helper, or isolated user-data profile is tracked.

- [ ] **Step 6: Commit**

```bash
git add docs/engineering/apple-feasibility-procedure.md test/appleFeasibilityDocumentation.test.mjs README.md
git commit -m "docs: add Apple feasibility runbook"
```

---

## Final Automated Acceptance

Run from a clean checkout on the supported Apple silicon Mac:

```bash
npm ci
npm run rebuild
npm run test:swift
npm run verify
npm run verify:e2e
npm run verify:package
node --test test/appleFeasibilityDocumentation.test.mjs
```

Expected outcomes:

- Swift protocol, core, macOS-fixture, and stdio tests pass.
- TypeScript typecheck, ESLint, Vitest, and package verifier tests pass.
- The nested helper is arm64, in `Contents/Helpers`, strictly signed, has the expected identifier, minimum OS, usage strings, and Apple Events entitlement.
- Packaged E2E proves handshake, sanitized capability reporting, and helper termination on app quit.
- No automated test prompts for TCC, calls a phone number, sends a message, reads personal Apple data, or writes the normal founder workspace.
- Live Apple capability claims remain unproven until the consenting manual procedure is run on the signed package and its sanitized results are reviewed.
