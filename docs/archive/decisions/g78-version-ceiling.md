# g78: the version gate is a compatibility ceiling

Lane g78, 25 September 2026. Audit item O04; triage decision 3, accepted by David: "gate
on a compatibility ceiling, not the exact latest desktop".

## The gap

`CONTAINER_CLIENT_VERSIONS` was `{ minimum, maximum }`, with the maximum pinned to the
exact latest desktop. A client above the maximum is refused every sign-in, renewal and
command. So every desktop-only release (1.0.1, 1.0.2, 1.0.3, 1.0.4) needed an API
deployment first, and publishing out of order locked every updated Mac out.

## Decision

The container holds a policy (`clientVersionPolicySchema` in
`packages/contracts/src/clientVersion.ts`):

- `minimum`: unchanged. Raising it forces every Mac onto a newer build.
- `ceiling`: a release line, `1.x` or `1.4.x`. It admits every build from the minimum
  to the top of the line, including builds that did not exist when the API was
  deployed. The top is `1.999.999`, or `1.4.999` for a minor line.
- `incompatible`: known-bad builds on the line. They are refused exactly like an
  outdated client (`client_upgrade_required`) until the Mac takes the next update.

Production ships `{ minimum: '1.0.0', ceiling: '1.x', incompatible: [] }`.

**What goes on the wire is the range, not the policy.** `/auth/client-version`, every
sign-in and renewal grant, `/diagnostics` and `/healthz` publish
`publishedClientVersions(policy)`, which is `{ minimum: '1.0.0', maximum: '1.999.999' }`.
The API checks versions with the same bound, so the API and a Mac reading the range
agree on every version the list does not name.

## Why 1.0.4 keeps working with no desktop change

Desktops 1.0.0 to 1.0.4 parse all four answers with the strict two-key
`clientVersionRangeSchema`. Their sessionManager then calls `clientCompatibility` and
`mayMutate` against that range.

- `1.999.999` is a valid semantic version, so the answer parses.
- `minimum ≤ maximum` holds, so the refine passes.
- 1.0.4 is inside the range, so the Mac reads itself as supported. The server's check,
  against the same bound and an empty list, agrees.

Two alternatives were rejected. A new `ceiling` key beside `supported` would make every
installed Mac refuse its own sign-in, because the schemas are strict. Omitting the
maximum would fail the same parse. The incompatible list is never published for the
same reason, and the API enforces it itself. A listed build learns the refusal code
from each answer. It does not get the upgrade screen up front, because its local check
cannot know it is listed.

## The version order from now on

- **Desktop-only (the normal case):** a new 1.x build that needs no route or field the
  deployed API lacks. Build and publish it. No API deployment.
- **API first:** the desktop needs a new route or a new response field. Deploy the API,
  smoke, then publish the desktop.
- **Desktop first:** a closed vocabulary gains a value (`g78-one-wire-contract.md`).
- **A breaking change:** raise the minimum, or ship 2.0.0 with a `2.x` ceiling.
- **A bad build:** add it to `incompatible`. That is an API deployment.

**1.0.5 is the last exact-pin release.** Production's API still publishes 1.0.4 as its
maximum and would refuse 1.0.5. The API carrying this policy is deployed first, once,
and then desktop 1.0.5 is published.

## Mutations

The two existing mutations that lowered `maximum` now add 1.0.1 and 1.0.2 to
`incompatible`. A third removes the list check from `clientCompatibility`;
`apps/api/test/clientVersionCeiling.test.ts` must then go red.
