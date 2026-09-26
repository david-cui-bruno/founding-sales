# g86: the promotion copies a bare manifest as itself, and tags the image, never a wrapper

Lane g86, 25 September 2026. The promotion of `e220f468` was refused on the evening of
25 September. `infra/scripts/release-promote.sh` (lane g74) copied the API image from
`fss-rh-api` to `fss-prod-api`, read the tag back, and found `7abeaab5…` where the
release said `87730328…`.

## Why

The images workflow's `publish` job pushes each image as a bare
`application/vnd.oci.image.manifest.v1+json`. A local `buildx --push` pushes an OCI
index. Given one source, `docker buildx imagetools create` has a default,
`--prefer-index=true`: it wraps a bare manifest in a new index. So it pushed the image
itself into the destination by digest, untagged, and put the release's tag on a wrapper
whose digest is another. The read-back refused, as it should. The copy was faithful
only for images that were already an index, which is what the stubs of lane g74 modelled.

## Decision

1. **A carbon copy.** The copy is
   `imagetools create --tag <prod>:<tag> --prefer-index=false <rh>@<digest>`. For one
   source, that copies the manifest as it is, index or bare manifest, so the tag names
   the source digest. The operator's buildx (v0.32.1) documents the flag. `--tag` stays
   first because the release workflow's dry-run job greps for that prefix.
2. **The read-back still decides.** If the tag names another digest — an older buildx
   that ignores the flag, or anything else — the copy is not trusted and not undone.
   - The source digest must now be in the destination repository, or the script fails
     naming both digests.
   - If it is there, that exact manifest is tagged where it is. `aws ecr batch-get-image`
     reads it by digest with `--accepted-media-types` set to the source's recorded type,
     and the bytes are written to a file untouched.
   - `aws ecr put-image` then tags them with `--image-digest`, which ECR refuses unless
     the bytes hash to that digest. The new tag is read back, and a mismatch fails.
3. **An untagged image in production is tagged, not skipped.** "Already present" now
   means present under some tag. An image present under none is tagged in place the same
   way. That is the child the refused `e220f468` promotion left in `fss-prod-api`.
   The lifecycle policy expires untagged images (`infra/modules/registry`), and a task
   definition naming that digest would stop being able to start a task.
4. **Which tag.** The repositories are IMMUTABLE, and after a wrapping copy the release's
   tag is the wrapper's. So the image gets the release's tag if it is free, otherwise
   `<tag>-image`, and the script prints which one (`copied-and-tagged <tag>`,
   `tagged-in-place <tag>`). A candidate that names another digest is passed over, never
   overwritten, and when both do the script refuses and asks for `--tag`. The brief
   suggested `ci-<commit>` as the fallback. That is already the default tag, so it
   cannot be the second choice.
5. **The one write.** `put-image` is the only non-read call the script makes to ECR, and
   `promote_aws` allows it only on `fss-prod-api` and `fss-prod-worker`. It runs with the
   operator's admin profile, as the copy always did. No IAM statement changes. The
   deployment digests are unchanged: deploy the digest the release names, not a tag.

## Evidence, offline

`test/release/releaseManifest.check.ts` runs the real script against stubbed `aws` and
`docker` (`test/release/support/cliStubs.ts`). The docker stub can now wrap as buildx
does.

- A bare manifest is copied as itself: the tag names the digest, and nothing is tagged
  in place.
- A copy that wraps leaves the release tag on the wrapper. The image is tagged
  `<tag>-image` by its own manifest, byte for byte, with `--image-digest`, in the
  production repository only.
- A copy that lands elsewhere with the image missing is refused, naming both, with no
  `put-image`.
- A production repository holding the image untagged beside a wrapper gets it tagged in
  place, and nothing is copied.
- Both candidate tags taken is a refusal.

Three mutations take each half away and turn that file red.

## For the operator, after this merges

Re-run `infra/scripts/release-promote.sh image-digests.json --app-only` for `e220f468`.
The API image is already in `fss-prod-api` untagged: expect
`tagged-in-place ci-<commit>-image`. `ci-<commit>` stays on the wrapper, which nothing
deploys. The worker is copied as itself. Then deploy the two digests as before. Nothing
here has been run against ECR.
