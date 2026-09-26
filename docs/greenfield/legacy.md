# The previous-generation app: deleted

Lane g95 (25 September 2026) deleted the previous-generation app from the repository.
The greenfield tree (`apps/`, `packages/`, `infra/`, `test/release/`, the root scripts
listed below, `docs/greenfield/` and `docs/archive/decisions/`) is now the whole repository.
The last commit that holds the old app is the tag **`legacy-final`**; check it out to
read, run or recover any of it.

David stopped using the old app on 19 September 2026, and the greenfield stack is what
runs in production. Lane g89 had already taken the old app off every default path (its
scripts under `legacy:`, its CI jobs only when a change touched it); lane g95 removed it.

## What was deleted

| Path | What it was |
|---|---|
| `src/` | The old desktop app: Electron main, preload, renderer, encrypted SQLite, migrations, domain |
| `client/` | The thin client of the 18 September rebuild plan (slice S6) |
| `cloud/` | The delegated worker Lambda, its Terraform module and root, and the state-bootstrap script |
| `native/`, `contracts/` | The Swift phone helper (`apple-bridge`) and its protocol, and the `safe-log-fs` Node addon |
| `tests/`, `test/*.test.*` | The old app's tests and its release tooling's tests |
| `scripts/` except the five below | The old app's build, package, release, backup and scan tooling |
| `forge.config.ts`, `forge.env.d.ts`, `vite.*.config.ts`, `vitest.config.mts`, `playwright.config.mjs`, `tsconfig.json`, `knip.json`, `.prettierrc`, `application-presentation.html`, `assets/`, `build/` | The old app's build, test and format configuration |
| `package.json`: every `legacy:*` script, `main`, `productName`, every `dependencies` entry and the old app's devDependencies (Electron Forge, `@electron/rebuild`, the SQLite driver, React, Vite, Playwright, knip, prettier and their types) | The old app's install and build |
| `.github/workflows/release.yml`; the `old-trees-changed`, `source` and `client` jobs of `.github/workflows/ci.yml` | The old app's release gate and CI |
| `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/engineering/`, `docs/cutover/`, `docs/acceptance/`, `docs/archive/`, `docs/known-company-extraction.md`, `docs/outreach-setup.md`, `docs/sourcing/founder-actions/alert-setup.md`, `.superpowers/` | The old app's documentation and history |
| `packages/domain/test/oracle/portedModules.test.ts` | The oracle run that checked each ported module against the old one; temporary by construction (`docs/archive/decisions/g0-oracle-imports.md`) |

`DELETION-MAP-20260918.md` (the reachability audit of 18 September, in the
coordinator's `.context/` notes) and David's answers of 18 and 19 September are the
decisions behind it.

## What stays at the root

- `package.json`, the npm workspace root. Its scripts are the greenfield ones and
  `verify:secrets`. The
  `postinstall` is still `install-electron --no`: the desktop host tests need the
  Electron binary (`docs/greenfield/install.md`), and `electron` itself now comes from
  `apps/desktop`.
- The root scripts: `scripts/verifySecrets.mjs` (the Gitleaks scan of the history and
  the tracked tree; its old `--package` mode scanned the old app's packaged bundle and
  is gone) and `scripts/productionSmoke.mjs`. The mutation check was deleted on
  26 September 2026.
- `eslint.config.mjs`, one flat config for the workspace and those scripts.
- `.gitleaks.toml`, unchanged apart from comments. Its two appended exceptions pinned to
  deleted files (`cloud/scripts/bootstrap-terraform-state.sh` and
  `tests/integration/appleSpikePreload.test.ts`) stay, because the history scan reads
  every commit and those files are still in it.
- `docs/sourcing/founder-actions/` (APRA request, attorney questions, DNC registration,
  privacy notice): founder paperwork, not code.

## In CI

The gate is `.github/workflows/greenfield.yml`, on every push and pull request, on
Linux: the `greenfield` job (typecheck, lint, the workspace tests and the release suite)
and the `secrets` job, `npm run verify:secrets` over the full history and the tracked
tree with Gitleaks 8.30.1 from the `linux_x64` tarball, pinned by its SHA-256. The old
`ci.yml` ("Source security gate") was folded into it on 26 September 2026. The other
workflows are the desktop host job and release (`greenfield-desktop.yml`), images,
deploy, infra, the release rehearsal and the monthly drill.

## The old worker's AWS resources

Deleting the code deleted nothing in AWS. Whatever of the old delegated worker is still
deployed in the account is managed from its Terraform at `legacy-final`
(`cloud/worker-terraform`). The old data tables were destroyed on 17 September 2026, so
there is nothing to carry into FSS; the carry tool and its runbook were deleted on
26 September 2026.
