# suppression_journal_failure

**Metric:** `SuppressionJournalWriteFailures` · **Severity:** critical · **Spec:** 10.2, Appendix E

## Symptoms

A write to the object-locked S3 suppression journal failed. The command that needed it
was refused: "A lost journal write fails the command." A salesperson or a prospect's
opt-out could not be recorded.

## First checks

1. The structured log event that produced the metric — it names the stage and the
   deterministic event id, and no prospect data.
2. The bucket: existence, object-lock configuration, bucket policy, and the API task
   role's `s3:PutObject` permission.
3. Whether the failure is every write or one write. One is usually a transient 5xx that
   the caller's refusal already handled.

## Diagnosis

Journal writes happen **before** acknowledgement, so this alarm means suppressions are
being refused rather than silently lost — which is the design working. Causes:

- the bucket policy or KMS key policy changed;
- the task role lost the permission;
- object lock is configured in a mode that refuses the write;
- a regional S3 incident.

## Safe recovery

- Restore the permission or policy, then have the salesperson re-record the
  suppression. A journal event that outlives a failed database transaction is safe to
  replay and may conservatively retain a suppression, so replay is the safe direction.
- Deterministic event ids mean a replayed write is the same object; a duplicate is not
  possible.

## Escalation

Page immediately and treat it as a compliance incident, not an availability one. If
any prospect asked to stop during the window, record it manually as soon as the journal
is writable and note the delay.

## What must stay held

- Never disable the journal write to "unblock" suppressions. A suppression that is not
  journalled is a suppression that a database restore silently reverses (Appendix E).
- Never relax object lock. The lock is what makes the journal a replay source after a
  restore.
- Do not tell a salesperson their suppression was recorded. It was refused.
