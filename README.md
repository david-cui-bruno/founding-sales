# Callie Founder Sales System (FSS)

Callie is a 24/7 maintenance agent for property managers: it handles tenant requests and coordinates contractors, including calling them when needed. FSS is the system the founder uses to find independent and regional residential property-management firms, call them, and follow up by email. FSS also keeps business relationships, conversation evidence, opportunities and action-focused **Today** work, with an **Ask** section for grounded retrieval. Research, mailbox sync, processing and guarded sequences run in the cloud; the Mac app provides the user interface. Current source readiness and actual deployed capability status are distinct; consult [current operating state](docs/operations/current-state.md).

## What is in this repository

| Path | What lives there |
| --- | --- |
| `apps/api` | The HTTP API on Fargate: Google sign-in, sessions and devices, the command and read routes the Mac calls, administration. |
| `apps/worker` | The worker on Fargate: the job queue, mailbox sync, sequences and sending, the operations command line (`fss`). |
| `apps/desktop` | The Mac app (Electron): sign-in, Today, firms, calls, replies, settings, the signed update channel. |
| `packages/domain` | The rules and the PostgreSQL 16 schema and migrations, shared by the API and the worker. |
| `packages/contracts` | The zod wire contracts shared by all three apps. |
| `infra/` | Terraform: the modules, the rehearsal and production roots, the deployment roles' policies and the release scripts (`infra/README.md`). |
| `test/ops` | The ops suite: the release and deploy scripts against stub CLIs, the deployment role policies, the alarm digest and the code-to-Terraform cross-checks. |
| `docs/greenfield/` | How each part works and how it is released; `docs/archive/decisions/` has the decisions made along the way. |

A connected account, a configured model and source completion are not live permission. Daily selling uses research → call → outcome → human-chosen regular follow-up → reply handling → Today. Ask is plain record/keyword search, not generated answering. AI booking lifecycle, automatic email admission and recurring posting have been removed. Cal.com sync, manual LinkedIn drafting/ledger and historical privacy paths remain.

At the root, `scripts/` holds secret scanning and smoke checks, and `certs/` contains the RDS CA bundle. The previous-generation app is recoverable from tag `legacy-final`; its [historical note](docs/archive/greenfield/pre-lean-docs-20261018/legacy.md) is archived. Finished plans and dated research live in `docs/archive/`, excluded from ordinary agent reading.

## Quick start

You need an Apple Silicon Mac and Node.js 24 (24.20.0 in CI). Put the Homebrew Node 24 binaries first on `PATH` for every command:

```bash
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
git clone https://github.com/david-cui-bruno/founding-sales.git && cd founding-sales
npm ci --no-audit --no-fund       # fetches the Electron binary, which the desktop host tests need
npx playwright install chromium   # only for the desktop window specs
```

```bash
npm run gate:greenfield           # typecheck, lint, every workspace's tests and the ops suite; what CI runs
npm run typecheck                 # = typecheck:greenfield
npm run lint                      # one ESLint config over apps, packages, test/ops and scripts
npm test                          # current workspace and ops suites
npm run test:desktop:e2e          # the desktop window in chromium; not part of the gate
FSS_DESKTOP_PACKAGE_MODE=local-smoke npm run package:desktop -- /tmp/callie-smoke   # an unsigned local bundle
```

The tests run against a real PostgreSQL 16 (embedded locally, a service container in CI); `docs/greenfield/workspace.md` has the details and `docs/greenfield/install.md` the desktop build, signing and update channel.

## Read next

- [CRM/Ask module map](docs/agents/crm-ask-modules.md): owning modules and test seams for capture, evidence, retrieval and deletion.

- [Daily selling guide](docs/operations/how-to-sell.md), [current operating state](docs/operations/current-state.md) and [roadmap](docs/sourcing/roadmap-20261007.md): setup, dated acceptance and current priorities.
- [Current release procedure](docs/operations/lean-release-workflow.md): the existing supported execution path. `docs/greenfield/release.md` retains detailed invariants and safety references, not an alternative approval.
- `docs/greenfield/processes.md`: actual API/worker composition and current module entrypoints.
- `docs/greenfield/today.md`, `calling.md`, `sequences.md`, `mail.md`, `settings.md`: retained product behavior. `sending.md` and `suppression.md` retain independent safeguards.
- `docs/greenfield/infra-topology.md`, `infra-apply-runbook.md` and `runbooks/restore.md`: existing infrastructure/recovery instructions. This documentation reduction does not simplify or replace the release path.

## Working rules

Ship small pull requests around one outcome, with the release suite's vacuous-pass traps named and closed. Keep honest states (unavailable, unknown, held) and never hide a missing live setup behind fixture success. Saving or approving is never sending, calling or booking. No secret value ever enters the repository: configuration names only, and `npm run verify:secrets` scans the history and the tree on every change.
