# Runtime, Recovery, and Security Hardening Design

**Status:** Approved

**Date:** 2026-09-04

**Product:** Callie Founder Sales System

## 1. Purpose

Make the local and cloud system fail visibly, recover predictably, and avoid storing operational credentials or prospect PII in unsafe locations. This work follows the outbound compliance hardening and must be completed before scaling founder outreach.

## 2. Confirmed problems

The audit established:

1. The local sourcing poller was more than five hours stale with backlog remaining while the general application health still reported ready.
2. S3 list, fetch, and body-read operations have no bounded deadline. One unresolved promise keeps `activePoll` set, and all future timer ticks coalesce onto it.
3. Poller failure state is not included in the primary health response, and packaged process logs are not retained usefully.
4. The resolver Lambda lacks permission to create or write its CloudWatch log stream.
5. The live encrypted CRM is much newer and larger than its latest pre-migration backup. No periodic current backup or Time Machine destination was present.
6. Recovery-key parsing exists, but the production product has no complete founder-facing export and restore workflow.
7. Sensitive provider and AWS credentials are present in local Terraform inputs/state and Lambda environment configuration.
8. PII-bearing values can enter local and CloudWatch logs.
9. The release verification command fails, no repository CI workflow enforces it, and the production feature branch is far ahead of main.
10. A prior migration may have merged different cloud-linked people solely by normalized display name.

## 3. Runtime poller design

### 3.1 Bounded operations

Every remote operation receives an abort signal and deadline:

- list objects: 30 seconds
- fetch object metadata/body: 60 seconds
- transform body text: included in the same 60-second budget
- upstream upload: 60 seconds

A timeout is a normal recorded failure. It clears the active poll in `finally`, preserves unprocessed ledger state, and permits the next scheduled attempt.

### 3.2 Poll identity and health

Track:

```ts
type PollExecutionState = {
  state: 'idle' | 'running';
  pollId: string | null;
  startedAt: string | null;
  lastCompletedAt: string | null;
  consecutiveFailures: number;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  backlogCount: number | null;
};
```

Health becomes degraded when:

- a poll runs longer than its total deadline
- no successful poll completed within twice the 15-minute cadence
- backlog remains nonzero across consecutive completed polls
- credentials exist but polling has never completed

The application health UI shows the degraded reason and a safe Retry action. Retry starts a new poll only when no non-expired poll owns the slot.

### 3.3 Watchdog

A local watchdog evaluates poll age at least once per minute. It does not abandon shared database work. It aborts only the owned remote request, records the timeout, and releases the poll slot after the promise settles.

## 4. Cloud observability

Add the resolver log-group ARN to the shared execution role and verify the next scheduled invocation creates a stream.

All scheduled components expose:

- invocation, error, throttle, and duration metrics
- age-of-last-success metric or heartbeat
- backlog or unprocessed-object count when applicable
- alarms that route to a confirmed notification target

Logs use structured event codes and identifiers. They exclude phone numbers, email addresses, person names, raw message subjects, and raw provider payloads.

## 5. Current encrypted backup design

### 5.1 Backup creation

Add a periodic backup service using the same verified encrypted-copy discipline as migration backups:

1. checkpoint and stabilize the database
2. retain the source descriptor and identity
3. copy to a new mode-0600 file in a mode-0700 directory
4. fsync the file and directory
5. verify encrypted header, SQLCipher open, integrity, and schema
6. compute and retain SHA-256 metadata
7. restore normal WAL operation

Backup keys are immutable and timestamped. No in-place overwrite occurs.

Default schedule is daily while the app is open, with an additional pre-release backup. Retention is 14 daily and 8 weekly local copies. External backup configuration remains founder-controlled.

### 5.2 Recovery material

Settings provides an explicit recovery setup flow:

- require founder confirmation
- generate recovery material from the active workspace key
- display it once with copy and save-to-chosen-location actions
- never log or persist the plaintext recovery material automatically
- record only that recovery setup was completed and when

The product warns that an encrypted database copy without recovery material may be unrecoverable after loss of the Mac keychain.

### 5.3 Restore drill

A restore test operates on a temporary copy, never the live database:

1. parse supplied recovery material
2. open the selected encrypted backup
3. run integrity and schema checks
4. read non-sensitive aggregate counts
5. close and securely remove the temporary working copy
6. produce a receipt containing backup timestamp, checksum, schema, and verification time

The founder must complete one restore drill before the system is considered outreach-ready.

## 6. Credential and Terraform security

### 6.1 Immediate containment

Rotate the affected enrichment-provider and AWS credentials. Do not place replacement values in repository-local plaintext files.

### 6.2 Target state

- Store runtime secrets in AWS Systems Manager Parameter Store or Secrets Manager with KMS encryption.
- Lambda configuration contains parameter identifiers, not secret values.
- Use an encrypted, access-controlled remote Terraform state backend with locking.
- Commit only example variable files containing non-secret placeholders.
- After a protected local credential envelope is verified, securely remove the plaintext import file.
- Restrict secret and state artifacts to mode 0600 with private parent directories during migration.

A secret scan runs in CI and release verification. It scans tracked history and the build context while excluding generated dependency output.

## 7. Identity-migration audit and repair

Before contacting cloud-linked prospects, compare the pre-schema-8 backup with the current database to find groups that:

- shared a normalized display name
- had different postal codes, property addresses, or cloud entity identifiers
- were merged into one current person

The audit is read-only and produces a repair manifest. A human reviews every candidate before repair.

Repair creates separate people and prospects from retained source evidence, reattaches properties and source events deterministically, and leaves an immutable merge-correction audit event. It never guesses phone ownership. Ambiguous contacts return to unknown identity and remain blocked.

## 8. Release gate

Use Node 24 for all repository verification commands.

The release gate runs:

1. typecheck
2. lint over tracked source and configuration, excluding generated Lambda `dist` output
3. unit and integration tests
4. Lambda package tests
5. package verification
6. secret scan
7. exact-SHA package marker comparison

Add CI for pull requests and protected-branch updates. Release artifacts are built from an exact tagged commit that is reachable from the protected main branch. Until branch reconciliation completes, freeze releases to an explicitly audited SHA rather than rebuilding from an ambiguous checkout.

## 9. PII-safe logging

Create central field allowlists for local and cloud structured loggers. Allowed fields include event code, component, request ID, object key, duration, counts, and sanitized error class.

Disallowed fields include:

- person or organization names
- phone numbers and emails
- raw message subjects or bodies
- property street addresses
- provider payloads
- recovery material or credentials

Tests pass representative sensitive values and assert that serialized logs do not contain them.

## 10. Rollout sequence

1. Restart the current app once and verify the existing backlog drains as temporary containment.
2. Implement poll deadlines, state reporting, and watchdog behavior.
3. Add resolver log permissions and verify the next scheduled invocation.
4. Rotate credentials and move runtime secret retrieval to managed storage.
5. Create and verify a current encrypted backup and recovery flow.
6. Run the read-only migration audit and review its repair manifest.
7. Implement approved identity repairs.
8. Add logging redaction and CI/release enforcement.
9. Perform packaged runtime, backup-restore, poller-timeout, and release-gate verification.

## 11. Verification requirements

Tests and operational checks must prove:

- a hung S3 operation times out, records failure, and permits the next poll
- stale polling degrades health before five hours can elapse
- backlog and last-success age are visible
- resolver logs appear after the IAM change
- a current backup opens with recovery material and passes integrity checks
- backup failure never damages the live WAL/database
- replacement credentials are absent from local Terraform plaintext and Lambda environment values
- sensitive values are redacted from logs
- same-name, different-identity migration candidates are surfaced without mutation
- the full Node 24 release gate passes in CI and on the exact release SHA