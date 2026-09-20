# G5b: the gate reported success on a failing test run

**Date:** 20 September 2026 · **Lane:** G5b process bootstrap · **Spec:** 16.1, 16.2

## The symptom

`npm run gate:greenfield` exited 0 while printing seven failures. Reduced:

```
apps/worker $ npx vitest run test/__gatecheck.test.ts   # one failing assertion
 Test Files  1 failed (1)
      Tests  1 failed (1)
EXIT=0

packages/contracts $ npx vitest run test/__gatecheck.test.ts   # the same test
 Test Files  1 failed (1)
EXIT=1
```

The difference between the two workspaces is the Vitest `globalSetup` that starts the
embedded PostgreSQL. With `FSS_TEST_POSTGRES_URL` set — a CI service container — the
worker workspace exits 1 as well.

So: **a release gate that could not fail**, on every machine that uses the local
cluster, which is every machine except CI.

## The cause

Not npm, and not Vitest. `async_hooks` attribution of the `process.exit` call:

```
[probe] exit(0) while exitCode=1
  at doExit            node_modules/async-exit-hook/index.js:24
  at stepTowardExit    node_modules/async-exit-hook/index.js:30
  at gracefulShutdown  node_modules/embedded-postgres/dist/index.js:387
  at runHook           node_modules/async-exit-hook/index.js:48
```

`embedded-postgres` registers a cleanup hook at **import** time:

```js
// embedded-postgres/dist/index.js
AsyncExitHook(gracefulShutdown);
```

and `async-exit-hook` hooks `beforeExit` with a hard-coded code:

```js
add.hookEvent('beforeExit', 0);                    // index.js:90
...
process.nextTick(process.exit.bind(null, code));   // index.js:24, code === 0
```

`beforeExit` is precisely how a Vitest run ends. The reporter sets
`process.exitCode = 1`, the event loop drains, and the process should exit with that
code. Instead the hook runs `gracefulShutdown` — which by then has nothing to do,
because the Vitest teardown already stopped the cluster — and finishes by calling
`process.exit(0)`, discarding the 1.

CI never saw it because `startPostgresCluster` returns for the service container
*before* `await import('embedded-postgres')`, so the hook is never registered.

### The second one, which the first was hiding

Removing only the `beforeExit` listener turned a **passing** run into exit 1:

```
TypeError: done is not a function
 ❯ node_modules/embedded-postgres/dist/index.js:393
```

`async-exit-hook` registers `exit` with no code, so its `runHook` takes the synchronous
branch and calls `gracefulShutdown()` **without** the `done` callback the function
declares. That has always been broken; it was invisible because the `beforeExit` hook
ran first and set the package's `called` flag, which makes the `exit` path return
early. Both listeners have to go together.

## The fix

`packages/domain/db/testing/embeddedPostgres.ts` snapshots `process.listeners` for
`beforeExit` and `exit` immediately before the dynamic import and removes whatever the
import added:

```ts
const listenersBeforeImport = snapshotExitListeners();
const { default: EmbeddedPostgres } = await import('embedded-postgres');
removeExitListenersAddedSince(listenersBeforeImport);
```

The diff is taken against a snapshot rather than matching on the package's internals,
so it keeps working if the package registers from somewhere else, and it removes
nothing the repository put there itself.

**The signal hooks stay.** `async-exit-hook` also hooks `SIGINT`, `SIGTERM` and
`SIGHUP`, and those exit with `128 + signal`, which is the correct code for a signal.
They are what stops a Ctrl-C during a test run from leaving a postgres behind, and they
were never part of the problem.

**The safety net is replaced, not dropped.** The cluster now registers its own
`beforeExit` listener that stops itself and does not exit:

```ts
process.once('beforeExit', () => { void stop().catch(() => undefined); });
```

Starting async work in `beforeExit` keeps the loop alive for another turn, which is how
the stop gets to finish, and nothing in it touches `process.exitCode`. `stop()` is
idempotent, so the ordinary path — the Vitest teardown — makes it a no-op.

## Why the fix is not "wrap it in a script that checks the output"

Parsing reporter output for the word "failed" is how a gate learns to lie in a new way.
The exit status is the contract; it was being overwritten, and the overwrite is what
had to stop.

## The npm-side hardening, kept as insurance

`test:greenfield` and `typecheck:greenfield` were one `npm run … --workspace a
--workspace b …` invocation. That form does propagate a failure on npm 11.19.0 — it was
not the cause — but a single per-workspace chain is one line and fails at the first
failing workspace, which is the same fail-fast shape `gate:greenfield` already has for
typecheck, lint and test:

```
"test:greenfield": "npm run test --workspace packages/contracts && npm run test --workspace packages/domain && …"
```

The trade-off is that a later workspace is not run once an earlier one has failed. For
a release gate that is the right way round.

## How it was proved

A deliberately failing test was added to `packages/domain`, `apps/api` and
`apps/worker` in turn: each exited 1, a passing run in each still exited 0 with no
unhandled rejection, and the chained `gate:greenfield` exited 1 at the first failing
workspace. The probes were removed in the same session.

`packages/domain/test/db/exitListeners.test.ts` keeps the mechanism honest with
synthetic listeners, so it proves the removal in CI too, where `embedded-postgres` is
never imported.
