# G11: the AWS SDK is a devDependency and a lazy import

The carry reads the old DynamoDB table and writes the S3 suppression journal.
`@aws-sdk/client-dynamodb` and `@aws-sdk/client-s3` are **devDependencies** of
`@fss/worker`, and they are still loaded lazily.

## Why devDependencies rather than dependencies

`Dockerfile.worker` installs with `npm ci --ignore-scripts --omit=dev`, so neither
package is in the worker image — which is right twice over. The image would otherwise
carry ten megabytes of SDK for code it cannot run: `Dockerfile.worker.dockerignore`
allows `apps/worker/src` back into the build context and nothing else, so `tools/`
never ships. That exclusion is deliberate. The carry holds AWS credentials and a
decryption identity, and a production task has no business being able to run it.

David runs the carry from a full local install, where devDependencies are present, so
the runbook installs nothing and restores nothing.

## Why the import is still lazy

`apps/worker/tools/carry/awsClients.ts` is the only file in the carry that names an
SDK, and both imports are `await import(specifier)` behind a `const specifier` the
compiler does not resolve — the pattern `packages/domain/jobs/metricsCloudWatch.ts`
established for CloudWatch. Nothing in `npm run gate:greenfield` loads an SDK and no
test reaches a network, because everything else takes a function:
`pagedOldTableReader` takes a `DynamoQuery`, `runCarryImport` takes a
`SuppressionJournal`, and the tests supply their own.

If a package is somehow absent, `loadDynamoQuery` and `loadS3SuppressionJournal`
throw `OldTableAdapterError('sdk_unavailable', …)` naming it — a refusal with an
instruction, not a module-not-found stack.

## Two things the adapter does that are not obvious

`ConsistentRead` is on. The export runs once, immediately after the schedule is
disabled, and an eventually consistent read could miss the last write the old worker
made before it stopped — which is precisely the delta the watermark exists to bound.

The journal put is conditional (`IfNoneMatch: '*'`) and a `PreconditionFailed` is a
success, because the object is already durable and that is the only thing the caller
needed to know. Section 10.2 has no exception for an import: a carried opt-out that
was not journalled is an opt-out a restore could lose (Appendix E step 2).
