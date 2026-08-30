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
