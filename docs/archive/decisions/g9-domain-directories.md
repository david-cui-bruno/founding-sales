# G9: two new `packages/domain` directories, and what that obliged

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** COMMON-G, 13.4

This lane's ownership list names `packages/domain/dashboard/**`. It does not name a
settings directory, and the work needs one: versioned configuration is a store with
commands, a change history and a set of pure "what does this setting mean" functions,
and none of that is a dashboard.

So there are two: `packages/domain/settings` and `packages/domain/dashboard`. Neither
collides with another lane's ownership. Putting the settings store inside
`dashboard/` would have kept the letter of the list and left the next reader looking
for `updateSetting` in a directory named after a different thing.

## What a new domain directory obliged

COMMON-G's lesson from G3b: a new `packages/domain/<dir>` that an application imports
must be named in that image's Dockerfile **and** its dockerignore, or the container
fails at load with `ERR_MODULE_NOT_FOUND`. Both are named in `Dockerfile.api` and
`Dockerfile.api.dockerignore`; the worker imports neither, so its allow-list is
unchanged, and `packages/domain/test/policy/imageClosure.test.ts` derives the closure
from real imports and would fail if that were wrong.

Also needed, and easy to miss because nothing fails until a test runs: the `exports`
map in `packages/domain/package.json`, and the alias lists in
`apps/api/vitest.config.ts` and `apps/api/tsconfig.json`. Vitest resolves the
workspace packages to their sources through those aliases rather than through the
exports map, so a subpath added to one and not the other fails only under test.
