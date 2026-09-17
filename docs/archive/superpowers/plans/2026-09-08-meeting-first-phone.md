# A: Real Mac Calling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an explicit FSS Call action reach Apple's own-number calling route without bypassing suppression or presenting handoff as a completed call.

**Architecture:** Retain `createOutboundCommandService` and `createPhoneHandoffLauncher`. Supply a concrete readiness barrier and a narrowly scoped native route driver. Add one-shot route commands to the existing signed helper before normal bridge bootstrap, so they do not initialize Contacts, Messages, Notes or recording.

**Tech Stack:** Existing TypeScript/Electron, Swift 6/AppKit/Security, Zod, Vitest and Swift Testing/XCTest conventions. Supported native baseline remains macOS 26.4+ on arm64.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, §§3,6–8,10. Read the [coordination plan](2026-09-08-meeting-first-fss.md) first.

## Global Constraints

- “No automated prospecting voice, recording, automated SMS, LinkedIn bot or whole-mailbox training is included.”
- “A handoff result is not proof of a connection.”
- “There is no automatic fallback to a second sender when a worker is unreachable.”
- All shared constraints, Node 24 PATH prefix, one-owner native/package gates and separate live-activation approvals from the coordination plan apply.
- Preserve current `OutboundRequest`, result ledger, exact target snapshot, consumed preflight, lock/wake/restore fences and unknown-result behavior. B4 adds a company-route counterpart rather than weakening person authorization.

## File structure and dependencies

A1: `src/main/communications/inboundReadiness.ts` owns registry/checkpoint logic. A2: native `PhoneRouteDriver.swift` and `PhoneRouteMode.swift` own signed Apple route lookup and handoff, with `phoneLaunchDriver.ts` adapting to the existing port. A3: `phoneRouteSettings.ts` and startup/Settings wiring own explicit setup and integration. A4 proves the package on a consenting endpoint.

### Task A1: Implement the actual inbound-readiness barrier

**Files:**
- Create: `src/main/communications/inboundReadiness.ts`
- Create: `tests/main/inboundReadiness.test.ts`
- Read/retain: `src/main/communications/outboundPorts.ts`, `outboundCommandService.ts`
- Existing regression: `tests/main/outboundCommandService.test.ts`

**Interfaces:** Consumes `OutboundReadinessPort`. Produces `createInboundReadiness(registry: InboundRegistry): InboundReadiness`. The legacy `check(personId,signal)` delegates to `checkSubject({kind:'person',id:personId},signal)`; B4 uses the same core with an account subject.

```ts
export type OutboundSubject = {kind:'person'|'account'; id:string};
export type InboundReadiness = OutboundReadinessPort & {
  checkSubject(subject:OutboundSubject, signal:AbortSignal):ReturnType<OutboundReadinessPort['check']>;
};
export type InboundAdapter = Readonly<{
  id: string;
  relevant(subject: OutboundSubject): boolean;
  synchronize(subject: OutboundSubject, signal: AbortSignal): Promise<{revision: string}>;
  isAppliedCurrent(subject: OutboundSubject, revision: string): boolean;
}>;
export interface InboundRegistry {
  snapshot(): {initialized: boolean; revision: number; adapters: readonly InboundAdapter[]};
}
```

- [ ] **RED:** construct a registry whose relevant adapter rejects. Assert readiness is blocked and the assembled command service never dispatches. Include an initialized empty registry and an uninitialized registry as different cases.

```ts
const registry: InboundRegistry = {snapshot: () => ({initialized: false, revision: 0, adapters: []})};
const readiness = createInboundReadiness(registry);
expect(await readiness.check('person-1', new AbortController().signal))
  .toEqual({kind: 'blocked', reasonCode: 'inbound_safety_unwired'});
```

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/inboundReadiness.test.ts
```

- [ ] **Implement:** capture initialized registry revision before awaits; sync only relevant enabled adapters; retain their returned revisions; require the same initialized registry revision, non-aborted signal and all `isAppliedCurrent` checks at the end. Fail closed on exceptions/missing adapters. `getCapability()` reports registry availability only, never synchronization success. No age-based invented freshness or blanket `ready=true`.

```ts
const before = registry.snapshot();
if (!before.initialized || signal.aborted) return blocked;
const relevant = before.adapters.filter(a => a.relevant(subject));
const checkpoints = await Promise.all(relevant.map(async adapter => ({
  adapter, checkpoint: await adapter.synchronize(subject, signal),
})));
const after = registry.snapshot();
const current = after.initialized && before.revision === after.revision && !signal.aborted
  && checkpoints.every(({adapter, checkpoint}) => adapter.isAppliedCurrent(subject, checkpoint.revision));
return current ? {kind: 'ready'} : blocked;
```

This is the `checkSubject` body. Here `blocked` is the exact typed object asserted above, defined once in the module. The production registry starts explicitly empty only when configuration establishes no enabled inbound adapters. C3/C6 register mail/worker checkpoints later; manual LinkedIn is not falsely advertised as an automatic adapter.

- [ ] **GREEN:** run the new suite plus existing command-service tests. Cover opt-out applied during synchronization, changed registry, abort, stale checkpoint and two successive attempts requiring two fresh synchronizations.
- [ ] **Commit:** stage the two created files only, message `feat: add initialized inbound readiness barrier`.

### Task A2: Bind a signed, exact Apple route without launching on inspection

**Files:**
- Create: `native/apple-bridge/Sources/CallieAppleMacOS/PhoneRouteDriver.swift`
- Create: `native/apple-bridge/Sources/CallieAppleBridge/PhoneRouteMode.swift`
- Create: `native/apple-bridge/Tests/CallieAppleMacOSTests/PhoneRouteDriverTests.swift`
- Modify: `native/apple-bridge/Sources/CallieAppleBridge/main.swift`
- Create: `src/main/communications/phoneLaunchDriver.ts`
- Create: `tests/main/phoneLaunchDriver.test.ts`
- Read/retain: `src/main/appleBridge/helperPath.ts`, `verifyHelperSignature.ts`, `src/main/communications/phoneHandoffLauncher.ts`

**Interfaces:** Produces `createNativePhoneLaunchDriver(input: NativePhoneDriverOptions): PhoneLaunchDriver`. Options contain the verified packaged helper path, a read-only `setupFingerprint(): string | null`, and injected async/sync process runners for tests. Strict one-shot JSON replies are `{version:1,status:'available',fingerprint:string}` or `{version:1,status:'unavailable',reason:string}`. No phone number or local path is echoed.

- [ ] **RED:** fake the native runner returning changed fingerprints between inspect and sync check. Assert the existing launcher opens zero targets. Test constructor/inspection never invoking the open mode.

```ts
const driver = createNativePhoneLaunchDriver(options);
expect(await driver.inspectVerifiedHandler()).toBe('phone_continuity_verified');
syncReply = {version: 1, status: 'available', fingerprint: 'changed'};
expect(driver.isVerifiedHandlerCurrent()).toBe(false);
expect(openRequests).toEqual([]);
```

`options`, `syncReply` and `openRequests` are local fixture values in this new test, supplying the two injected process runners and a matching initial setup fingerprint. They must not resolve a real helper path or start an OS app.

- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/main/phoneLaunchDriver.test.ts tests/main/phoneHandoffLauncher.test.ts
```

- [ ] **Implement native mode:** branch on exact `--phone-route-inspect` or `--phone-route-open` before `AppleBridgeBootstrap.compose`. All other arguments keep their current behavior. Inspection uses AppKit/LaunchServices application lookup and Security code-signature validation. First supported route is the signed Apple Phone app identified by existing `PhoneAXContract.bundleIdentifier = "com.apple.mobilephone"`; do not infer identity from display name or add unverified fallback applications. Hash canonical route identity, code identity and OS/app version into the fingerprint. Opening reads one bounded strict stdin JSON request containing canonical E.164 target and expected fingerprint, revalidates both, then calls the concrete AppKit opener with the exact verified application URL. Never use shell interpolation, default-browser navigation or AX clicks to auto-confirm an Apple prompt.

```swift
// The production boundary, after strict target/signature/fingerprint validation:
NSWorkspace.shared.open(
    [targetURL], withApplicationAt: applicationURL,
    configuration: NSWorkspace.OpenConfiguration(),
    completionHandler: completion
)
```

The new Swift driver injects lookup/validation/opener closures for tests. `PhoneRouteMode` has a bounded input frame and one result, with no normal bridge dependency construction. Inspecting a handler cannot prove the iPhone/carrier is presently reachable. The stored setup proof in A3 plus A4's real call establishes the configured route; UI must keep that distinction.

- [ ] **Implement TS adapter:** reuse packaged helper resolution/signature verification. Async inspection compares the native fingerprint to saved explicit setup proof. The synchronous currency method performs a bounded one-shot inspect (one second maximum, no stdout over 4 KiB). `openTelUri` synchronously starts the one-shot open process with stdin, then observes its promise. A launch rejection is unknown, not permission to retry. No raw stderr/target enters logs. Failure or changed fingerprint requires setup again, never a stale success cache.
- [ ] **GREEN:** run the above tests and coordinator-owned `swift test --package-path native/apple-bridge --filter PhoneRouteDriverTests`. Verify wrong signature/identifier, changed app, malformed target, unsupported platform, truncated JSON, timeout and cancel. Inspect fixture tests must show zero calls to the opener. Retain existing strict phone target tests.
- [ ] **Commit:** stage only listed A2 files, message `feat: bind explicit Apple Phone route driver`.

### Task A3: Compose setup, readiness and the existing outbound transaction

**Files:**
- Create: `src/main/communications/phoneRouteSettings.ts`
- Create: `src/shared/contracts/phoneSetupContract.ts`
- Create: `src/main/communications/registerPhoneSetupIpc.ts`
- Create: `src/preload/apis/phoneSetupApi.ts`
- Modify: `src/main/startApplication.ts`
- Modify: `src/main.ts`
- Modify: `src/preload/createCallieApi.ts`
- Modify: `src/shared/preload.d.ts`
- Modify: `src/renderer/foundation/ConnectionsSection.tsx`
- Modify: `src/renderer/features/leadInspector/InspectorOverview.tsx`
- Modify: `src/renderer/foundation/SettingsScreen.test.tsx`
- Create: `tests/integration/phoneRouteStartup.test.ts`
- Modify: `tests/main/startApplication.test.ts`
- Modify: `tests/main/main.test.ts`
- Create: `tests/e2e/phoneHandoff.spec.ts`

**Interfaces:** `PhoneRouteSettings` exposes `read(): PhoneSetup | null`, `confirm(input: PhoneSetup): void`, `clear(): void`. `PhoneSetup` binds route fingerprint and explicit confirmation time, without copying an Apple password or phone account credentials. `PhoneSetupApi.status()`, `confirm({expectedFingerprint})` and `clear()` return strict validated setup status; the main process obtains the current fingerprint and confirmation time rather than trusting a renderer-supplied timestamp. Add optional factory injection `createPhoneBindings(runtime): {phone: PhoneHandoffPort; readiness: OutboundReadinessPort}` to startup dependencies. Test default dependencies remain explicitly unavailable. Backend/IPC work proceeds independently; the listed renderer changes wait for D3's focused setup/connection presentation review.

- [ ] **RED:** assemble real command service/domain with fictional bindings. After final preparation, assert the driver is invoked once, one durable outbound intent exists, and no conversation activity/meeting is invented. Invalidate during pending inspection and assert zero dispatch.
- [ ] **Run RED:**

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npx vitest run tests/integration/phoneRouteStartup.test.ts tests/main/startApplication.test.ts
```

- [ ] **Implement:** production composition uses A1/A2 rather than the two unconditional unavailable factories. The setup UI, reviewed with D3's connection-state presentation, explains own-iPhone service and retains the Apple confirmation prompt. Store only a strict bounded setup record via a main-process atomic private file. It can be confirmed only by an explicit user setup action, not a capability read or environment variable. Reuse the current `beginOutbound` command from the selected exact contact. Preserve existing prepare→immediate dispatch→receipt ordering:

```ts
const bindings = dependencies.createPhoneBindings?.(runtime) ?? {
  phone: unavailablePhoneHandoff(), readiness: unavailableOutboundReadiness(),
};
outbound = createOutboundCommandService({domain, ...bindings});
```

Wire disposal/invalidation and safe capability copy; available means configured handoff, never connected call. Call controls explain unknown DNC/invalid contact/route configuration without manufacturing eligibility. No live call is part of startup, setup inspection or E2E boot. Mock-keychain/fictional runs receive an explicit fixture driver that captures an invocation instead of opening `tel:`.

- [ ] **GREEN:** focused startup/main/launcher/domain/outbound suites, typecheck and lint. Existing packaged test must prove explicit click only, cancellation, no duplicate dispatch after double-click/restart, and unchanged lifecycle before a real reported outcome. Run it against a separate candidate only after the coordinator packages once.
- [ ] **Commit:** stage owned files only, message `feat: wire configured calling through outbound authorization`.

### Task A4: Prove one real call, or report the actual blocker

**Files:**
- Modify: `docs/outreach-setup.md`
- Create: `docs/acceptance/meeting-first-calling.md` with no personal target/account data
- Existing acceptance source: `tests/e2e/phoneHandoff.spec.ts`

**Interfaces:** Consumes A3's package, not a diagnostic script bypassing FSS. Produces a dated acceptance result tied to commit/package identity, with `passed` or `acceptance_blocked` and nonsecret reason.

- [ ] Verify the isolated package's marker, signature, fixture tests and no default outbound side effects. Document supported OS/device/carrier prerequisites using Apple's current device-calling guide.
- [ ] Request bounded authorization for one actual manually initiated call and a named consenting endpoint. Obtain confirmation that the own-iPhone route is configured. Do not choose a prospect, scrape contacts, or substitute an arbitrary number.
- [ ] In the approved setup only, click FSS Call, observe Apple's route/confirmation and the recipient's actual caller ID and ringing/connection. Cancel a second prepared attempt before calling. Verify no automatic retry. Capture only nonsecret outcome metadata, not call audio.
- [ ] Confirm persisted handoff is separate from the user-reported conversation outcome, reopen safely, and verify no replay. A missing iPhone/carrier/Apple setting is an explicit blocker, not `handoff_accepted` evidence.
- [ ] Update setup instructions with the demonstrated behavior and commit documentation only. This task is not complete until real endpoint evidence exists; offline A1–A3 may still be complete independently.
