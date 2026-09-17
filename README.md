# Callie Founder Sales System (FSS)

Callie is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed. FSS is the local-first macOS app the founder uses to find independent and regional residential property-management firms, prepare each one from saved evidence, and call them.

## Who it is for now

For the next three months the user is David alone (decided 17 September 2026). Working means: every morning **Today** shows many property-management firms ready to call, he calls as many as he wants, and ideally no manual preparation step exists. The app does the work and shows a readable log. Holds remain only where money is spent, something is sent, or a call is placed. The priorities that follow from this are in `docs/ROADMAP.md`.

## Current state (17 September 2026)

- Installed build **62ffefe** (17 September, 00:04 UTC); deployed delegated worker **62ffefe** (16 September, 23:22 UTC). A merge alone updates neither.
- One real company (Lenox Management) is worker-owned, has an approved one-step manual-call campaign and is enrolled with its published business phone route; Today lists it as due.
- Nothing has been sent, no call has been placed and no calendar event has been written by the product. Installation, deployment, grants, calls, sends and purchases remain David's separate decisions.
- Delivered checkpoints, observed walkthroughs and honest limits: `docs/ROADMAP.md`.

## Quick start

You need an Apple Silicon Mac and Node.js 24 (24.20.0 for release gates). Put the Homebrew Node 24 binaries first on PATH for every command:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
git clone https://github.com/david-cui-bruno/founding-sales.git && cd founding-sales
npm ci --no-audit --no-fund   # root: postinstall fetches Electron and rebuilds the native SQLite driver (about 30 s with prebuilt binaries)
npm ci --prefix cloud/lambdas/shared --no-audit --no-fund
while IFS= read -r -d '' lock; do
  test "$lock" = cloud/lambdas/shared/package-lock.json && continue
  npm ci --prefix "${lock%/package-lock.json}" --no-audit --no-fund
done < <(git ls-files -z -- 'cloud/lambdas/*/package-lock.json')
npx playwright install chromium   # only needed for the browser specs
```

The root is not an npm workspace: each Lambda lockfile is installed on its own, `cloud/lambdas/shared` first. Root tests that import worker source fail with "Failed to load url @aws-sdk/client-dynamodb" until those installs are done. Never copy node_modules, profiles, keys or databases from another checkout.

```bash
npm start                          # Electron Forge dev app against your own local profile
npm test                           # root vitest: main, integration, renderer, shared, infrastructure
npm run typecheck && npm run lint:tracked
npx vitest run <paths>             # affected tests only while iterating
npm run test:browser:native-desk   # the Playwright Chromium group CI runs
```

The dev app creates an encrypted SQLite workspace under `~/Library/Application Support/Callie Founder Sales System/`; automated tests never touch it. Packaging, the release gate (`npm run verify:release`), the pre-release backup, fuses and code signing are documented in `docs/engineering/release.md`.

## Repository map

| Path | What lives there |
| --- | --- |
| `src/main.ts`, `src/main/` | Electron main process: encrypted SQLite and migrations (`src/main/db/`), domain (`src/main/domain/`), validated IPC (`src/main/ipc/`), delegation runtime (`src/main/delegation/`), company research (`src/main/research/`), backups (`src/main/backup/`), Apple bridge supervisor (`src/main/appleBridge/`). |
| `src/renderer/` | React 19 UI: shell and route registry in `src/renderer/app/`; Today, Accounts and Campaigns in `src/renderer/features/today/`, `src/renderer/features/campaigns/` and `src/renderer/features/linkedin/`; legacy person routes in `src/renderer/features/leads/`, `src/renderer/features/pipeline/`, `src/renderer/features/conversations/`, `src/renderer/features/learnings/`, `src/renderer/features/friday/` and `src/renderer/features/review/`; Settings in `src/renderer/foundation/`. |
| `src/preload.ts`, `src/preload/` | The renderer bridge exposed as window.callie: one Zod-validated API per feature in `src/preload/apis/`. |
| `src/shared/` | Contracts shared by main, preload, renderer and worker (`src/shared/contracts/`), account ranking and the approved product facts. |
| `cloud/lambdas/delegated-worker/` | The delegated worker Lambda: owner commands, campaigns, mail polling, research pipeline. Deployed only from `cloud/worker-terraform/`. |
| `cloud/terraform/modules/delegated-worker/` | The worker's Terraform module, used only by `cloud/worker-terraform/`. The legacy public-record sourcing stack was destroyed in AWS on 17 September 2026 and its code removed the same day. |
| `native/apple-bridge/`, `contracts/apple-bridge/v1/` | Swift helper for call observation on the Mac and its fixed JSON Lines protocol. |
| `tests/`, `test/`, `scripts/` | Vitest suites, Playwright browser specs, packaged end-to-end specs; release tooling tests; the gate and backup scripts. |
| `docs/` | `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, dated reports and the release manual in `docs/engineering/`, superseded designs in `docs/archive/`. |

## Read next

- `docs/ARCHITECTURE.md`: process model, validated IPC, the two data models and which routes use which, delegation flow, research, storage, tests and gates.
- `docs/engineering/release.md`: `npm run verify:release`, `npm run backup:pre-release`, Electron fuses, signing, packaged end-to-end tests and data isolation, moved verbatim from this README.
- `docs/ROADMAP.md`: delivered checkpoints, the 17 September decisions and the priority order.
- `docs/engineering/2026-09-17-audit-closure.md`: what happened to the 18 findings of the 10 September adversarial audit.

## Working rules

Ship small PRs around one user-visible outcome. Run affected tests, `npm run typecheck` and lint while iterating; one combined gate runs before a merge. Keep honest states (unavailable, unknown, held) and never hide a missing live setup behind fixture success. Saving or approving is never sending, calling or booking. Preserve command identity across retries: never re-issue a new command id after an uncertain result.
