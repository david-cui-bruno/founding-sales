# Callie Founder Sales System (FSS)

Callie is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed. FSS is the system the founder uses to find independent and regional residential property-management firms, call them, and follow up by email. Every morning **Today** lists the firms to call; the work behind it (research, sequences, mailbox sync, suppression) runs in the cloud, and the Mac app is a thin client.

## What is in this repository

| Path | What lives there |
| --- | --- |
| `apps/api` | The HTTP API on Fargate: Google sign-in, sessions and devices, the command and read routes the Mac calls, administration. |
| `apps/worker` | The worker on Fargate: the job queue, mailbox sync, sequences and sending, the operations command line (`fss`). |
| `apps/desktop` | The Mac app (Electron): sign-in, Today, firms, calls, replies, settings, the signed update channel. |
| `packages/domain` | The rules and the PostgreSQL 16 schema and migrations, shared by the API and the worker. |
| `packages/contracts` | The zod wire contracts shared by all three apps. |
| `infra/` | Terraform: the modules, the rehearsal and production roots, the deployment roles' policies and the release scripts (`infra/README.md`). |
| `test/release` | The release suite (specification Appendix G and the checks added since). |
| `docs/greenfield/` | How each part works and how it is released; `docs/archive/decisions/` has the decisions made along the way. |

At the root: `scripts/` holds the secret scan (`verifySecrets.mjs`) and the production smoke, and `certs/` the RDS CA bundle the images trust. The previous-generation app was deleted in lane g95; the tag `legacy-final` holds its last tree ([`docs/greenfield/legacy.md`](docs/greenfield/legacy.md)).

## Quick start

You need an Apple Silicon Mac and Node.js 24 (24.20.0 in CI). Put the Homebrew Node 24 binaries first on `PATH` for every command:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
git clone https://github.com/david-cui-bruno/founding-sales.git && cd founding-sales
npm ci --no-audit --no-fund       # fetches the Electron binary, which the desktop host tests need
npx playwright install chromium   # only for the desktop window specs
```

```bash
npm run gate:greenfield           # typecheck, lint, every workspace's tests and the release suite; what CI runs
npm run typecheck                 # = typecheck:greenfield
npm run lint                      # one ESLint config over apps, packages, test/release and scripts
npm test                          # = test:greenfield and test:release
npm run test:desktop:e2e          # the desktop window in chromium; not part of the gate
FSS_DESKTOP_PACKAGE_MODE=local-smoke npm run package:desktop -- /tmp/callie-smoke   # an unsigned local bundle
```

The tests run against a real PostgreSQL 16 (embedded locally, a service container in CI); `docs/greenfield/workspace.md` has the details and `docs/greenfield/install.md` the desktop build, signing and update channel.

## Read next

- `docs/greenfield/release.md`: how a release goes out; production has been live since 24 September 2026. The records of the releases before 25 September are in `docs/archive/release-records.md`.
- `docs/greenfield/processes.md`: what the API and the worker do and how they start and stop.
- `docs/greenfield/today.md`, `sequences.md`, `sending.md`, `mail.md`, `suppression.md`: the product's rules, one area each.
- `docs/greenfield/infra-topology.md`, `infra-apply-runbook.md`: the AWS side.

## Working rules

Ship small pull requests around one outcome, with the release suite's vacuous-pass traps named and closed. Keep honest states (unavailable, unknown, held) and never hide a missing live setup behind fixture success. Saving or approving is never sending, calling or booking. No secret value ever enters the repository: configuration names only, and `npm run verify:secrets` scans the history and the tree on every change.
