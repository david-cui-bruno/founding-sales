# Local Native Desk acceptance

This acceptance slice connects the approved Native Desk to the current encrypted local database. It does not create a delegated workspace identity, grant authority, activate a worker, send outreach, or convert legacy people into researched PM accounts.

## Requirement-to-check map

| Requirement | Concrete checks |
| --- | --- |
| Explicit one-way local transition | `localWorkspaceIpc.test.ts` strict command/response and lifecycle checks; `SettingsScreen.test.tsx` acknowledgement, double-submit and response recovery; `meetingFirstWorkspace.spec.ts` actual packaged Settings command |
| Exact committed receipt recovery | `localWorkspaceReadService.test.ts` real transition, query-only read/reopen, immutable identity/fingerprint/state validation, corrupt account isolation; Chromium lost-response and exact-retry scenarios |
| Preserve existing commitments without reviving old acquisition | `localCommitments.test.ts` main evidence classification and negative controls; `localWorkspaceComposition.test.tsx` exact action/due identity and unchanged lifecycle tables before/after reads; packaged callback and parked-review assertions |
| Local account evidence without worker authority | Query-only account projections, actual encrypted reader-to-React account selection, Chromium separate local library, packaged null daily workspace and unconfigured delegation |
| Pure mounts and explicit navigation | Command-spy negatives and before/after database snapshots; retained-row selection followed by separate Open contact workspace action |
| Keep supported approval/recovery workflows | Existing `NativeDeskComposition.test.tsx` real outbox composition and all original Chromium groups, in addition to local-read scenarios |
| Preserve layout and editing | Chromium 1440/1050 viewports, light/dark and density coverage, three lanes, keyboard selection, editor node/caret/text retention; packaged screenshots and serious/critical Axe assertions |
| Safe package fixture ownership | `packagedFixtureDatabase.test.ts` stopped-child, captured-envelope, no-overwrite and encrypted seed checks; actual package bootstrap/reopen uses its genuine mock-keychain envelope |
| Durable local result | Actual packaged transition, normal stop and same-profile restart preserve the receipt, callback and local account while worker scope remains null |

## Fixture provenance

`tests/fixtures/localWorkspaceAcceptance.ts` uses production repositories, migrations and lifecycle commands. Its callback is supported by a real synthetic call activity after `reviewToReady`, not by a display label, `workIntent`, or raw action flag. A separate legacy acquisition review remains available to test parking. The PM account is synthetic and independent of those legacy people.

Packaged acceptance allocates only owned temporary profiles. It bootstraps the real signed application, retrieves only that synthetic profile's recovery material through IPC, observes normal process exit, captures the genuine mock-keychain envelope, seeds an encrypted current-schema database offline, and relaunches the same binary. No pairing credential, trusted workspace injection, certificate override, trust-store change or security-fuse change is used.

## Release gate

Before installation, the coordinator must run a fresh clean-HEAD root verification, all Lambda checks, all Native Desk Chromium groups, source/history and extracted-package secret scans, a separate signed candidate build, the complete packaged workflow suite, and post-run marker/signature/fuse checks. A green source or fixture test alone is not packaged acceptance. Exact logs, counts, commit and bundle hashes belong in the private release receipt and delivery handoff, not an inferred claim here.

The new packaged scenario was first run against the previous signed binary and failed at the missing `localWorkspace.get` API after genuine profile bootstrap/relaunch. This is a meaningful preimplementation negative control.

## Boundaries that remain separate

- Positive **unpaired local viewing and transition** is covered by this slice.
- Positive **genuinely paired worker execution** remains a separate acceptance boundary. Local evidence is never substituted for authenticated pairing, owner receipts or provider capability.
- Fixture success is not permission for real calls, messages, invitations, grants, campaign activation, purchases, deployment or publication.
- Real rollout requires a fresh normal-quit, closed-handle, hash-verified profile and app backup, exact-candidate installation, and supported UI observations. If the real due queue is empty, it must remain honestly empty.
