# Local browser slice, issue #738

Approved October22 2026 at05:39UTC. This is local synthetic-data implementation, not a hosted launch or production data migration. ADR0012 is the shared security boundary. Existing desktop and production129 remain unchanged.

## Sequence and exclusive ownership

| Outcome | Owner | Exclusive files | Waits |
| --- | --- | --- | --- |
| Shared platform/session contract | Hatchling | `src/shared/browserContract.ts`, `src/server/runtime.ts`, ADR0012, workspace configuration | Committed7dac0db29/e85ccde08, focused tests/types/workflow passed |
| Browser authentication and selected API gateway | Snake | `src/server/**` except runtime, `test/server/**` | Locked contract only, no UI or PG dependency |
| Browser UI/transport and durable existing action | Squid | `src/client/**`, `test/client/**` | Locked contract, server-owned client version |
| Actual local-browser acceptance | Swan | `test/e2e/**`, `test/support/**`, `playwright.config.ts` | Actual server/UI code for execution, sole disposable-PG lane |
| Integration, checks, finished review and docs | Hatchling | Workspace/lock/config, this plan and normal current docs | Whole implementation and actual acceptance |

One shared isolated worktree starts from exact main881. Owners commit only their own files, never stage another owner's changes or spawn workers. Root handles shared contract changes. Only Swan may run disposable PostgreSQL, maxWorkers1, with explicit teardown and release. Auth/UI focused checks are fake-only and cannot imply browser acceptance.

## Observable acceptance

1. Real local HTTPS browser login -> Today -> existing synthetic Firm -> reload -> logout. Use signed local OIDC through existing API authentication and an isolated real database, no Electron or injected principal.
2. Existing meeting-note read/save on that Firm's synthetic meeting. Preserve exact command identity across reload, duplicate and lost-response handling. Check identity transitions and revocation before dispatch and after response. Discovery creation/link migration is not part of this slice.
3. Finished spec, standards and privacy reviews, normal focused checks and actual Chromium acceptance. Retain any concrete limits instead of calling source completion live selling readiness.

## Local transport

Use an ephemeral synthetic localhost TLS certificate and isolated headless browser profile. Ignore certificate errors only in this local fixture. Server HTTPS, Secure/HttpOnly host cookies, Origin/CSRF, current membership/revocation and command guards are never relaxed for tests. No installed desktop profile, Keychain, real provider or production data is used.

No new hosting, service/account, spend, OAuth registration, production routing, backend relocation, deployment, contact or sending activation is included. Owner OFF, consent, source limits and budgets remain unchanged. The parked native Firm/Today, permitted Gmail-original and useful owner workflow outcomes remain open.
