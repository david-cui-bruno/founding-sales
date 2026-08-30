# Task 5 — Safe Notes and Messages Feasibility Adapters

## Status

Implemented and verified. The reviewed `BridgeCoordinator` and synchronous stdio boundary were not restructured. A separate `FeasibilityBridgeCommandHandler` dispatches only the four fixed Notes/Messages methods and delegates all other methods to `BoundedBridgeCommandHandler`.

The pre-release V1 send contract now strictly requires a `commandId` different from the envelope `id`, the bounded recipient/body fields, and the exact confirmation literal `I CONSENT TO THIS TEST MESSAGE` in both Swift Codable and TypeScript Zod.

## Delivered

- Platform-neutral Core Notes/Messages values, typed errors, synchronous throwing ports, and fixed-method composition handler.
- Fixed in-process Apple Event descriptor construction for constant Notes and Messages bundle targets and constant event codes. Caller values are data/file/object descriptors; there is no script source, shell, or generic Apple Event bridge.
- Opaque Notes artifact registry and bounded, duplicate-safe recording scan independent of transcript availability.
- Canonical 0700 staging-root export with generated filenames, path/symlink containment, streamed SHA-256/byte counting, deletion and absence verification, success/error cleanup, and contained startup/shutdown abandoned-entry cleanup.
- Messages send client with exact manual confirmation, explicit command ID, one send attempt, and fixed no-payload errors.
- Immutable Messages SQLite reader using `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_FULLMUTEX`, `mode=ro&immutable=1`, a 100 ms busy timeout, a seven-day window, 500-row limit, version/column validation, bound values, and fixed read-only SQL.
- Inert production dependency composition. Initialization and handshake create/clean only the staging root; they do not send Apple Events or open Messages.
- Committed synthetic supported/unsupported Messages schema fixtures and a synthetic cross-runtime send request fixture.

## RED → GREEN evidence

1. Send-contract RED:
   - Bundled-Node Vitest: 2 failures. Zod rejected the new `commandId` and `confirmation` fields.
   - Swift: compile failure because `SendTestMessageParameters` lacked `commandId` and `confirmation`.
   - GREEN: 4/4 TypeScript contract tests and the Swift send safety test passed after strict parameter validation.

2. Adapter/handler RED:
   - Swift test compilation reported missing `PathContainment`, Notes/Messages adapters and ports, `FeasibilityBridgeCommandHandler`, and dependency container.
   - GREEN focused results: Notes 7, Messages 6, containment 4, handler 5, and container 2 tests passed.

3. Containment RED:
   - A dangling symlink beneath the staging root was accepted instead of throwing `escapeAttempt`.
   - A staging-root symlink itself was canonicalized rather than rejected.
   - GREEN: both are rejected; all four containment tests pass.

4. Distinct command-ID RED:
   - TypeScript and Swift both accepted `commandId == request.id`.
   - GREEN: both runtimes reject equality while accepting distinct UUIDs.

5. Notes robustness RED:
   - Empty Apple Event scan reply crashed with `Range requires lowerBound <= upperBound` (signal 5).
   - Failed export that created a dangling staging symlink left that entry behind.
   - GREEN: empty replies return no artifacts, and the contained symlink entry is removed without touching its target.

## Files

Created:

- `contracts/apple-bridge/v1/fixtures/messages-send.request.json`
- `native/apple-bridge/Sources/CallieAppleCore/FeasibilityBridgeCommandHandler.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/AppleEventExecuting.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/NotesRecordingLocator.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/NotesAttachmentExporter.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/MessagesScriptClient.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/MessagesReadStore.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/PathContainment.swift`
- `native/apple-bridge/Sources/CallieAppleMacOS/MacOSDependencyContainer.swift`
- `native/apple-bridge/Tests/CallieAppleCoreTests/FeasibilityBridgeCommandHandlerTests.swift`
- `native/apple-bridge/Tests/CallieAppleMacOSTests/NotesAdapterTests.swift`
- `native/apple-bridge/Tests/CallieAppleMacOSTests/MessagesAdapterTests.swift`
- `native/apple-bridge/Tests/CallieAppleMacOSTests/PathContainmentTests.swift`
- `native/apple-bridge/Tests/CallieAppleMacOSTests/MacOSDependencyContainerTests.swift`
- `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/messages-v26.sql`
- `native/apple-bridge/Tests/CallieAppleMacOSTests/Fixtures/messages-unsupported.sql`
- `native/apple-bridge/Tests/CallieAppleProtocolTests/SendTestMessageSafetyTests.swift`

Modified:

- `contracts/apple-bridge/v1/protocol.md`
- `src/shared/appleBridgeContract.ts`
- `tests/main/appleBridgeContract.test.ts`
- `native/apple-bridge/Package.swift`
- `native/apple-bridge/Sources/CallieAppleProtocol/Commands.swift`
- `native/apple-bridge/Sources/CallieAppleCore/Ports.swift`
- `native/apple-bridge/Sources/CallieAppleBridge/main.swift`
- `native/apple-bridge/Tests/CallieAppleProtocolTests/GoldenFixtureTests.swift`

## Final verification

- Bundled-Node `vitest run tests/main/appleBridgeContract.test.ts`: PASS, 4 tests.
- Bundled-Node `npm run typecheck`: PASS.
- Bundled-Node `npm run test:swift`: PASS, 103 tests in 13 suites.
- `swift build --package-path native/apple-bridge -c release --arch arm64`: PASS.
- Task-5 source scan for shell/process execution, `osascript`, executable source, and Messages write/migration vocabulary: clean.
- Protocol scan for caller paths, scripts, SQL, shell commands, or bundle IDs: clean.
- `git diff --check`: clean.
- SDK/SDEF authority check:
  - public `NSAppleEventDescriptor` bundle-target, file-URL, and send APIs are present in the selected SDK;
  - Notes attachment declares `save`, backed by fixed `coresave`/`kfil`;
  - Messages declares fixed `ichtsend`.

## Proof no live adapters or personal data were touched

- Every Apple Event test injected `FakeAppleEventExecutor`; `SystemAppleEventExecutor.execute` was never called.
- Every Messages read test created a temporary SQLite database from committed synthetic SQL. No test references or opens `~/Library/Messages/chat.db`.
- The production-composition test injected a nonexistent temporary Messages path and sent only typed `bridge.hello`/`bridge.shutdown` requests.
- Notes tests used temporary 0700 directories and synthetic bytes/descriptors only.
- Swift build/test compiled and linked the executable but did not launch its production `main`.
- No test accessed Notes, Messages, Contacts, Phone, Apple Events, TCC prompts, recordings, calls, or messages.

## Self-review

- Confirmed the reviewed call actor/coordinator and call-safety code are unchanged.
- Checked every side effect is behind a typed fixed command; handshake/construction is inert.
- Checked errors and stderr diagnostics are constant and exclude handle/body/path/SQL/Apple Event payloads.
- Checked all export exits remove the generated contained entry, including dangling-symlink failure.
- Checked SQLite source contains no write, attach, vacuum, migration, or arbitrary-query route.
- Mutation-oriented edge checks cover wrong consent, reused envelope ID, path traversal, root/child symlinks, duplicate/empty Notes replies, unsupported schema, and executor failure.

## Concerns

- This is intentionally a feasibility implementation. Fixed Notes attachment save and Messages participant/send descriptors compile and match the installed macOS 26 SDEFs, but binding constraints prohibited a live Notes/Messages/TCC exercise; runtime app behavior and permission UX remain unproven.
- The reader deliberately supports only the committed v26 schema/columns and degrades with `schema_unsupported` otherwise. `immutable=1` may observe a stale snapshot when recent data exists only in a WAL; it is retained because immutability/read-only safety is the governing constraint.
- Message delivery ambiguity is not retried here. The later Electron caller must persist the distinct command ID before dispatch and treat a timeout as ambiguous.

---

## Review round 1 remediation

### Status and interface ruling

All Critical and Important review findings, plus the confirmed duplicate-command gap, were remediated. `BridgeCommandHandling` remains synchronous, the reviewed `BridgeCoordinator` and call-recording actor were not modified, and `FeasibilityBridgeCommandHandler` remains the separate fixed-method composition layer.

### Delivered remediation

- Replaced path-based Notes export cleanup with a launch-lifetime canonical staging-root descriptor, generated 0700 per-export directories, `openat`/`fstatat`/`unlinkat`, `O_NOFOLLOW`, device/inode revalidation around the external save, descriptor-based streaming/hash counting, retrying deletion, and explicit `ENOENT` absence verification.
- Added the distinct `plaintextRetentionRisk` typed failure. An unverifiable provenance or exhausted deletion disables later exports and stores only an opaque UUID recovery signal. No proof can be returned on this path.
- Added root replacement, per-export-directory replacement, leaf symlink, leaf hard-link, deletion failure/retry/exhaustion, and outside generated-name tests. Outside/replacement content remains untouched.
- Fixed launch/shutdown cleanup to reopen `.` relative to the root descriptor. This avoids `dup` sharing the directory offset and ensures repeated cleanup passes enumerate from the beginning while remaining descriptor-relative.
- Replaced Messages display-name selection with a fixed property-test/whose object specifier on participant `handle` (`hndl`), resolves exactly one participant ID, and sends to that unique-ID (`ID  `) object specifier. Zero/multiple/malformed replies fail closed without sending.
- Added a synchronized attempted-command registry. The handler records the command UUID before calling Messages, rejects reuse after success, failure, or ambiguity, and rejects all new sends when its fixed capacity is full rather than evicting.
- Made UUID distinctness case-insensitive in TypeScript, matching Swift UUID value equality.
- Made recipient/body limits normative UTF-8 byte limits (256/4000) in protocol.md, TypeScript Zod, Swift Codable, and adapter validation.
- Pushed the Notes `since` constraint into a fixed Apple Event property test and added a bounded 501-candidate sentinel range. Because the installed Notes SDEF exposes no stable sort command, saturation is reported through `truncated`; filtering supported audio and deduplication precede the 500-artifact cap.
- Bounded the Notes artifact registry at 5,000 entries with fail-closed saturation and no eviction. Strengthened Messages tests with 600 recent rows plus an eight-day-old row to prove the 500-row limit and seven-day clamp.

### Round 1 RED → GREEN evidence

1. Cross-runtime contract:
   - RED: Vitest accepted mixed-case representations of the same request/command UUID and accepted multibyte strings exceeding the intended byte bounds.
   - GREEN: `tests/main/appleBridgeContract.test.ts` passed 5/5; Swift send-safety tests reject the mixed-case-equivalent UUID and agree on `é`/emoji byte boundaries.
2. Attempted command registry:
   - RED: handler tests could not construct a bounded registry and a failed send was dispatched again.
   - GREEN: handler suite passed 7/7; failed IDs remain attempted, and capacity saturation rejects without eviction.
3. Exact Messages handle:
   - RED: descriptor tests found name-form selection instead of a `hndl` property test, and zero/multiple resolution had no typed rejection.
   - GREEN: adapter tests decode `test`/`cmpd`/`hndl`/`=   ` and unique-ID send descriptors; Messages suite passed 7/7.
4. Notes scan completeness:
   - RED: the scan capped the first 500 unordered raw attachments before filtering and had no `truncated` metadata. The bounded-range descriptor test then reported five failed expectations before range construction existed.
   - GREEN: the fixed since query, 1...501 sentinel range, post-filter 500 cap, and typed truncation passed all descriptor/scan tests.
5. Descriptor-relative deletion and containment:
   - RED: the new adversarial tests initially failed compilation because descriptor deletion injection and `plaintextRetentionRisk` did not exist. The hard-link test subsequently returned an incorrect success proof.
   - GREEN: Notes suite passed 17/17, including deletion retry/exhaustion, no-proof-on-risk, root/leaf/export-directory swaps, hard-link rejection, unexpected-sibling rejection, and outside-file preservation.
6. Repeated cleanup:
   - RED: the first full Swift run passed 115/116; `shutdownCleansOnlyGeneratedContainedEntries` failed because `dup(rootFD)` shared the end-of-directory offset left by startup cleanup.
   - GREEN: reopening `.` with `openat` gives each cleanup an independent descriptor; the focused regression and the full 116-test Swift run passed.

### Final verification after remediation

- Bundled-Node focused contract test: PASS, 5 tests.
- Bundled-Node `npm run typecheck`: PASS.
- Focused Swift Notes/Messages/handler/protocol run: PASS, 31 tests; final Notes suite PASS, 17 tests.
- Bundled-Node `npm run test:swift`: PASS, 117 tests in 13 suites.
- Bundled-Node `npm run build:swift`: PASS, release arm64 build.
- `git diff --check`: clean.
- Safety scan for `Process(`, shells, `osascript`, AppleScript APIs/source, and SQLite `ATTACH`, `VACUUM`, and write vocabulary in native sources: no matches.
- Test-authority scan: no test references `homeDirectoryForCurrentUser`, `Library/Messages/chat.db`, or `SystemAppleEventExecutor`.

### SDK/SDEF authority evidence

- Installed Messages SDEF declares `send` as `ichtsend`, participant class `pres`, participant display `name` as `pnam`, exact `handle` as read-only `hndl`, and participant ID as `ID  `.
- Selected SDK `AEObjects.h` declares `formTest='test'`, `formUniqueID='ID  '`, `typeCompDescriptor='cmpd'`, and `obj1`/`obj2`/`relo`; `AERegistry.h` declares `kAEEquals='=   '` and `kAEGreaterThanEquals='>=  '`.
- Installed Notes SDEF declares attachment `atts`, creation date `ascd`, and an attachment response to the imported Cocoa Standard `save`; CocoaStandard.sdef declares `coresave` and destination parameter `kfil`.

### Proof no live adapters or personal data were touched in remediation

- All Apple Event behavior tests used `FakeAppleEventExecutor` and synthetic `NSAppleEventDescriptor` replies. No test called `SystemAppleEventExecutor.execute`.
- All Messages read tests generated temporary SQLite stores from committed synthetic SQL; no test opened the user's Messages database.
- Notes export tests used generated temporary 0700 roots and synthetic bytes only. Root/symlink/hard-link adversarial targets were temporary synthetic files.
- Production composition was only tested with a nonexistent temporary Messages path and typed hello/shutdown requests; it did not send an Apple Event or open a personal database.
- Build and test commands compiled/linked but did not launch the production executable. Notes, Messages, Contacts, Phone, TCC prompts, recordings, calls, and messages were not accessed.

### Round 1 self-review and concerns

- Reviewed every exporter exit after the external save: success requires verified deletion/absence; ordinary execution/hash failures delete first; any inability to verify deletion or binding returns `plaintextRetentionRisk`, produces no proof, and disables further export.
- Reviewed all cleanup targets: only validated generated names are handled, every leaf operation is relative to an opened contained descriptor, and no swapped absolute path is removed.
- Reviewed Messages authority: caller handle/body remain data descriptors, participant selection uses `hndl` rather than display `pnam`, and the send layer performs one explicit send only after exact consent and a unique resolution.
- Reviewed SQLite authority: immutable read-only URI/flags, fixed schema validation/query, 100 ms busy timeout, seven-day clamp, and 500-row limit remain intact; there is no write/migration/generic SQL route.
- The Apple Event save API necessarily receives an absolute file URL; it cannot consume the export directory descriptor. A path swap that occurs and is restored entirely during the external event cannot be eliminated with the public API. The helper revalidates root and per-export directory provenance immediately before/after the save and fails closed on observed change, never claiming to delete an unproven outside write.
- Notes exposes no stable sort command in its installed SDEF. The fixed since filter plus bounded sentinel page prevents an unbounded result, and saturation is explicitly incomplete (`truncated: true`), but real Notes ordering and TCC/runtime behavior remain unproven because live exercise was prohibited.

---

## Review round 2 remediation

### Ruling and implementation

The controller accepted the public Notes API boundary: a malicious concurrent same-user root/export-directory replacement during the absolute-path Apple Event save is outside the V1 threat model. Existing post-save provenance revalidation, no-proof `plaintextRetentionRisk`, opaque recovery UUID, and helper-lifetime export disable remain unchanged. The binding design spec now states that this is detected fail-closed behavior, not swap-resistant cleanup or descriptor-bound Notes write authority.

The remaining shutdown finding is fixed without changing `BridgeCommandHandling`, the reviewed `BridgeCoordinator`, or the call-recording actor:

- Added typed `BridgeShutdownError.cleanupVerificationFailed` in Core.
- Changed only the injected feasibility shutdown hook to synchronous throwing.
- `MacOSDependencyContainer` no longer suppresses `cleanAbandonedArtifacts()` failure with `try?`; it maps any adapter cleanup failure to the typed shutdown error.
- `FeasibilityBridgeCommandHandler` returns the existing successful `{"shuttingDown":true}` result only after cleanup returns successfully. The typed failure maps to a fixed, non-retryable `internal` response: `Bridge shutdown cleanup could not be verified.`
- The stdio server already latches its shutdown state only when the handler response is `ok`, so a cleanup-failure response does not falsely enter the clean-shutdown lifecycle branch.

### RED → GREEN evidence

- RED focused build: `BridgeShutdownError` was missing, and Swift rejected conversion of the desired throwing shutdown hook to the existing non-throwing hook.
- GREEN focused run: 11 tests passed across `FeasibilityBridgeCommandHandlerTests` and `MacOSDependencyContainerTests`.
- Success tests assert the exact request ID, `ok: true`, `result: {"shuttingDown":true}`, absent error, cleanup invocation, and contained generated-entry removal.
- Failure tests create only a temporary synthetic unexpected sidecar, force deletion/directory-absence verification failure, and assert the exact request ID, `ok: false`, nil result, `internal` code, fixed message, `retryable: false`, retained synthetic file, and absence of staging path/error payload leakage.

### Round 2 self-review and concerns

- The container erases the concrete adapter error at the Core boundary; no filesystem path, POSIX error, Apple payload, or retained filename reaches the bridge response.
- Failed cleanup does not return `shuttingDown: true`; no live Apple adapter, TCC prompt, personal database, recording, call, or message is involved in the tests.
- A client may still close stdin after receiving a failed shutdown response, causing normal EOF process exit. The bridge does not claim cleanup succeeded; later supervisor policy owns escalation/recovery for that failed response.

### Round 2 final verification

- Focused Swift handler/container run: PASS, 11 tests in 2 suites.
- Bundled-Node `npm run test:swift`: PASS, 119 tests in 13 suites.
- Bundled-Node `npm run build:swift`: PASS, release arm64 build.
- `git diff --check`: clean.
- Safety scans found no shell/process execution, AppleScript source/API, Messages write/migration vocabulary, live Messages database reference, or live Apple Event executor reference in tests.
- TypeScript sources/contracts were not changed in round 2, so no TypeScript verification was required by the round brief.
