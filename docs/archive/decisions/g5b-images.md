# G5b: what is in the images, and the one pin that is still a tag

**Date:** 20 September 2026 · **Lane:** G5b process bootstrap · **Spec:** 4.1, 16.2

## arm64, from the Dockerfile rather than from the builder

`FROM --platform=linux/arm64` is written into both files instead of being left to
`docker buildx --platform`. David chose ARM64 Fargate and
`infra/modules/cluster/main.tf` passes `cpu_architecture` into the task definition's
`runtime_platform`. An x86 image on an ARM64 task definition starts, fails with an
exec format error, and the deployment circuit breaker rolls it back — which is a long
way to find out something the Dockerfile can state.

## Only three workspaces, from the same lock file

`npm ci --omit=dev --ignore-scripts --workspace @fss/api --workspace @fss/domain
--workspace @fss/contracts` resolves from the repository's single `package-lock.json`
and installs only what those three declare: 45 packages, 26 MB. The old trees'
Electron, React, `better-sqlite3` and native modules are in the same lock file and
never enter the image.

`--ignore-scripts` is not only about speed. Nothing in the dependency graph gets to run
code while an image is being built, and neither image needs a native build.

The alternative — a hand-written production `package.json` inside the image — would
install dependencies the lock file does not pin, which is the one thing a lock file is
for.

## The base image is pinned by tag, not by digest

`node:24.20.0-bookworm-slim`. The patch version is pinned; the digest is not, because
this lane has no registry access to resolve one and a digest invented from nothing is
worse than a tag.

That is the remaining gap. The first apply directive should resolve the digest once —
`docker buildx imagetools inspect node:24.20.0-bookworm-slim` — and replace the
`NODE_IMAGE` default with `node:24.20.0-bookworm-slim@sha256:…`. It is a build
argument precisely so that change is one line and does not touch anything else.

Our own images are already digest-only where it matters: `infra/modules/cluster`
refuses a mutable tag in `api_image` and `worker_image`, because the release gate
compares the digest that passed rehearsal with the digest that is deployed (16.2).

## `--selftest`, and why CI runs it inside the image

Both entry points accept `--selftest`: read the environment, print the decisions, exit.
No socket, no database, no AWS client, no signal handler.

It is the cheapest test that catches the failure a unit test structurally cannot — a
module that resolves on a developer's machine because a development dependency is
installed, and does not resolve in a production image. CI runs it in both images, and
also runs it with a schema range the image does not accept, to prove the refusal fires
in the artefact rather than only in a test.

## No push

`.github/workflows/greenfield-images.yml` builds, prints digests, runs the selftests,
and asserts the images are arm64, non-root, and free of the test harness and of every
development dependency. It refuses to run at all if an AWS credential is present in the
environment.

Pushing needs a credential this repository does not have and should not have. The
`aws ecr` commands are at the bottom of the workflow and in the apply runbook, for an
operator running a directive.
