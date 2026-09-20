# G11: the AWS SDK is a lazy specifier, not a dependency of `@fss/worker`

The carry reads the old DynamoDB table and writes the S3 suppression journal. Neither
`@aws-sdk/client-dynamodb` nor `@aws-sdk/client-s3` is in `apps/worker/package.json`,
and `package-lock.json` is unchanged by this lane.

## The shape

`apps/worker/tools/carry/awsClients.ts` is the only file in the carry that names an
SDK, and both imports are `await import(specifier)` behind a `const specifier` the
compiler does not resolve — the pattern `packages/domain/jobs/metricsCloudWatch.ts`
established for CloudWatch. Everything else takes a function:
`pagedOldTableReader` takes a `DynamoQuery`, `runCarryImport` takes a
`SuppressionJournal`. Tests supply their own and never load an SDK.

## Why not a real dependency

**The worker image.** `Dockerfile.worker` installs `npm ci --workspace @fss/worker`,
so a dependency added for an operator tool would ship ten megabytes of SDK into every
production container — for code the container cannot run, because
`Dockerfile.worker.dockerignore` allows `apps/worker/src` back into the build context
and nothing else. `tools/` is excluded on purpose: the carry holds AWS credentials and
a decryption identity, and a production task has no business being able to run it.

**The lock file.** Adding two packages means regenerating `package-lock.json`, which
is the file every lane in flight would then conflict on, for a tool that runs once.

## What the operator does instead

Step 4 of `docs/greenfield/carry-runbook.md` installs them for the length of the
carry and step 11 restores the lock file:

```
npm install --no-save --no-audit --no-fund @aws-sdk/client-dynamodb @aws-sdk/client-s3
...
git checkout -- package-lock.json
```

If the packages are absent, `loadDynamoQuery` and `loadS3SuppressionJournal` throw
`OldTableAdapterError('sdk_unavailable', …)` naming the missing package — a refusal
with an instruction, not a module-not-found stack.

## Two things the adapter does that are not obvious

`ConsistentRead` is on. The export runs once, immediately after the schedule is
disabled, and an eventually consistent read could miss the last write the old worker
made before it stopped — which is precisely the delta the watermark exists to bound.

The journal put is conditional (`IfNoneMatch: '*'`) and a `PreconditionFailed` is a
success, because the object is already durable and that is the only thing the caller
needed to know. Section 10.2 has no exception for an import: a carried opt-out that
was not journalled is an opt-out a restore could lose (Appendix E step 2).
