# G5b: the images run TypeScript, with `--experimental-transform-types`

**Date:** 20 September 2026 · **Lane:** G5b process bootstrap · **Spec:** silent

## Spec silence

The specification names ECR, immutable digests and Fargate. It says nothing about
whether the artefact inside the image is TypeScript or compiled JavaScript, because
that is an implementation choice.

## Decision

Neither image has a build step. `node apps/worker/src/bootstrap/main.ts` runs the
sources, with `NODE_OPTIONS="--experimental-transform-types
--disable-warning=ExperimentalWarning"`.

## Why not plain type stripping

Node 24 strips types from `.ts` files with no flag at all, which would have been the
obvious answer. It refuses one thing the tree uses:

```
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not
supported in strip-only mode
    packages/domain/db/migrationRunner.ts:43
      constructor(readonly code: string, message: string) {
```

`MigrationError`, `JobStoreError`, `HandlerRegistryError` and `MetricError` all declare
constructor parameter properties. Strip-only mode cannot rewrite them, because doing so
changes the emitted code rather than deleting characters. `--experimental-transform-types`
does the rewrite.

**This is cheap to undo.** Four constructors, four lines each, and the flag comes out.
If a later lane touches those files anyway it should take the flag with it; nothing
else in the greenfield tree needs the transform. That belongs to the lanes that own
those files, not to this one.

## Why not compile

`tsc` emit would work, and it would need `rewriteRelativeImportExtensions`, an output
layout, and every workspace package's `exports` map repointed at `dist` — which would
change how vitest and the type checker resolve the same imports, in packages this lane
does not own, while two other lanes are working in them. A bundler would add a
dependency and a second definition of what a module is.

The gain would be the removal of one experimental flag from a container that already
pins the Node version to the patch. The cost is a build step in four packages during
the two weeks when the tree is being written by parallel lanes. Revisit when the tree
stops moving, or when the flag stops being enough.

## Why the warning is suppressed

`--disable-warning=ExperimentalWarning` keeps the one non-JSON line off stdout. Every
metric filter in `infra/modules/observability/main.tf` is a JSON pattern over `$.level`
or `$.event`; a line that is not JSON cannot match one, but it is the beginning of a
log group where some lines are structured and some are not, and that is how a filter
quietly stops being trustworthy.
