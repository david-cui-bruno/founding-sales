# G13b: how the release leaves the runner, and the digest it leaves on

**The open question.** G13a built, signed, notarized and verified a release and then
let the runner be destroyed. `docs/greenfield/install.md` recorded the choice it would
not make: either `actions/upload-artifact` — "a third action, which must be pinned to a
digest somebody has checked" — or an OIDC role that can write to the update bucket.

**Decision: `actions/upload-artifact`, pinned to a commit this lane resolved.** The
release job uploads `$RUNNER_TEMP/channel`, which holds `Callie-<version>-arm64.zip`
and the signed `latest.json`, as the artifact `callie-macos-arm64-<version>`. David
downloads it from the run and publishes it himself.

## The digest, and how it was checked

```
actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02
```

Resolved on 20 September 2026, from this machine, with git rather than with a web page:

```
git ls-remote --tags https://github.com/actions/upload-artifact.git
```

Two things in that output matter.

`refs/tags/v4.6.2` and `refs/tags/v4` both name `ea165f8d…`, which is what makes this
the current v4 release rather than an arbitrary commit on the branch.

Neither ref has a peeled `^{}` companion. `git ls-remote --tags` prints an extra
`<sha>\trefs/tags/<name>^{}` line for every **annotated** tag, naming the commit the
tag object points at. Their absence means both tags are lightweight and point directly
at a commit — so the forty characters above are a commit sha, which is the only thing
`uses:` treats as immutable. Had it been an annotated tag object, pinning to it would
have pinned to a tag, and a tag can be moved.

`apps/desktop/test/packaging/releaseWorkflow.test.ts` asserts that every `uses:` in the
workflow matches `owner/repo@[0-9a-f]{40}`, so a later edit cannot reintroduce `@v4` on
a runner that holds a Developer ID certificate and an app-specific password.

## Why not the OIDC role, which is the better answer

It is the better answer, and it is not this lane's. It needs an IAM role with a trust
policy for GitHub's OIDC provider, scoped to this repository and to the update bucket's
`releases/` prefix, in the account whose Terraform is G1's and whose roles are named in
`docs/greenfield/release.md` section 1.1. Improvising one from inside a workflow that
already holds the signing certificate is the wrong place to get identity wrong, and
there is no credential here to test it with.

It would also remove a step that is worth keeping for now. Publishing to the channel is
the moment every existing Mac is told there is something new; with the upload route it
is a person reading a version and a digest and typing three commands from
`install.md`, rather than the last line of a job. Version one has one operator and
perhaps one release a week. When that stops being true, the OIDC route is the upgrade,
and the manifest and the verifier do not change.

## What is uploaded, and what is not

The upload step runs after the verifier, after the manifest is signed and after the
stamp is compared with the commit — and it has no `if: always()`. A build that failed
any of those has nothing worth downloading, and an artifact that exists is an artifact
somebody will eventually install.

`compression-level: 0`, because the zip is already a zip and `ditto` made it; GitHub
adds a second envelope around any artifact regardless, which is why the download needs
one unzip before the commands in `install.md`. Retention is 90 days.

Nothing secret is in the artifact. The manifest carries a version, a commit, a URL, a
size, a digest and an Ed25519 signature; the public half of the signing key is inside
the bundle by construction, because that is how a Mac checks the next update.
