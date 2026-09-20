# G0: the greenfield CI job runs on Linux

**Spec silence.** COMMON-G says "In CI use a `postgres:16` service container" and does
not name a runner.

**Decision.** `.github/workflows/greenfield.yml` runs on `ubuntu-24.04`. The existing
"Source security gate" workflow stays on `macos-15` and is not edited.

**Why.** GitHub's service containers are Docker containers, and Docker is only
available on Linux runners. On macOS the job would have to install and manage
PostgreSQL itself, or fall back to `embedded-postgres`, and then the gate would no
longer be running against the same server image the specification names.

Nothing in `apps/*` or `packages/*` is macOS-specific. The parts of the product that
are — Electron packaging, Keychain, notarization, the `tel:` handoff — are tested on
macOS by the old workflow and, later, by the desktop lane, which is not G0's.

**Install.** `npm ci --ignore-scripts`. The old tree's `postinstall` downloads Electron
and builds two native modules; this job runs none of them. `embedded-postgres` needs no
install script on this path either, because the service container is used instead —
which also means the missing symlink hydration that matters locally does not matter
here.

**The password in the workflow file.** `POSTGRES_PASSWORD: greenfield-ci` is a literal
for a container that exists for the length of one job, is reachable only from that
job's network namespace, and holds nothing but generated test rows. It is not a
credential to any system. Nothing in the repository or in any environment reads it.

**Proved locally.** `node scripts/greenfieldServiceClusterCheck.mjs` runs the whole
gate against a cluster handed over through `FSS_TEST_POSTGRES_URL`, which is the branch
CI takes, so that code path is exercised on a developer machine and not only on the
runner.
