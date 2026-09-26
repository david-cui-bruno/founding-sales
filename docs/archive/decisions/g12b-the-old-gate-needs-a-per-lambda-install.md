# The old gate's seven local errors are a missing install, and prose is the honest fix

**Lane:** G12b · **Files:** `docs/greenfield/processes.md` (new final section). No code changed.

## What was open

On a fresh clone, after the documented greenfield install recipe, `npm run typecheck`
reports ten `TS2307: Cannot find module '@aws-sdk/client-ssm'`-shaped errors and
`npm run lint:tracked` reports seven `import/no-unresolved`, all of them in
`cloud/lambdas/delegated-worker/src`. Neither command is the greenfield gate, and
neither failure means anything is wrong.

`cloud/lambdas/*` are independent npm packages with their own pinned lock files, which
is a deliberate decision from two earlier lanes (`g1-provider-lock-files.md`,
`g0-old-gate-isolation.md`). The root `npm install` does not install them. The root
`tsconfig.json` and the old ESLint config still *read* their sources, so an uninstalled
dependency reads as a missing module. `.github/workflows/ci.yml` installs each lock
file before it runs the gate, which is exactly why CI is green and a laptop is not.

## The decision: document it, do not wrap it

The brief offered two options — make the failure message name the install step, or say
so in prose "if that is all that is honest". Prose, for three reasons.

**A wrapper would have to live where the lane may not write.** Naming the step in the
failure means replacing `"typecheck": "tsc --noEmit"` and
`"lint:tracked": "node scripts/lintTracked.mjs"` in the root `package.json` with a
script that probes for `cloud/lambdas/*/node_modules` first. The root `package.json`
and `scripts/lintTracked.mjs` are the old trees' gate, outside this lane's ownership,
and on CI's critical path — the tree where a lane is least entitled to be inventive
for a diagnostic's sake.

**It would be a second place to keep true.** The probe would have to know which lock
files exist and stay right as the lambdas are deleted (the D2 deletion PRs remove these
trees). A paragraph that says "run the loop `ci.yml` already runs" cannot drift from
`ci.yml` in the same way, because it quotes it.

**The honest statement is short and it is not really an error.** A greenfield lane
never needs to run the old gate: the old trees are frozen, no lane may edit them, and
`gate:greenfield` excludes them entirely. The thing a person needs is one paragraph
saying "this is expected, here is the one command that clears it, and you probably do
not need to". That is now the last section of `docs/greenfield/processes.md`, with the
exact loop from `ci.yml`:

```bash
while IFS= read -r -d '' lock; do
  npm ci --prefix "${lock%/package-lock.json}"
done < <(git ls-files -z -- 'cloud/lambdas/*/package-lock.json')
```

## What was checked, and what was not

Checked: the failures are exactly and only in `cloud/lambdas/delegated-worker`, they
are all unresolved `@aws-sdk/*` imports, `cloud/lambdas/delegated-worker/node_modules`
is absent after the root install, and `ci.yml` runs the loop above before
`npm run typecheck`.

Not checked: that the loop clears every error on this machine. Running it would
download and install a second dependency tree into a frozen directory that this lane
is forbidden to edit, to prove something `ci.yml` already demonstrates on every push of
the old trees. The claim rests on CI being green, which is a stronger witness than one
laptop.
