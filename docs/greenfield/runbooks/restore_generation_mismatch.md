# restore_generation_mismatch

**Metric:** `RestoreGenerationMismatches` · **Severity:** critical · **Spec:** Appendix E

## Symptoms

The database's `system_generation` does not match the operator-controlled expected
generation. Restore holds are blocking sending and dialing. `/readyz` fails closed.

## First checks

1. `GET /diagnostics`: the applied generation and the expected generation side by side.
2. Was a restore performed, intentionally or not? An unexpected mismatch means the
   service is pointed at a database it was not deployed against.
3. The restore point, and what was accepted between it and now.

## Diagnosis

This is Appendix E step 1 working. Two very different situations produce it:

- **A deliberate restore.** Expected; the protocol below applies.
- **A configuration error** — the expected generation was changed, or the service is
  connected to the wrong database. That is the dangerous one, because advancing the
  generation to "fix" it would release restore holds on a database nobody has
  reconciled.

## Safe recovery

Run Appendix E in order and do not skip a step:

1. Replay the suppression journal from the restore point minus one hour, inserting
   every missing event idempotently.
2. Search every mailbox Sent folder from the restore point minus ten minutes for FSS
   Message-IDs, inserting sent tombstones for missing fences.
3. Reprocess every mailbox inbox from the same point so replies, opt-outs, direct sends
   and bounces reapply.
4. Discard runnable job state and rematerialize from business state.
5. Renew every Gmail watch and prove coverage for every mailbox.
6. Reapply migrations and validate service schema ranges if the restore predates one.
7. Produce reconciliation counts and unresolved exceptions for review.
8. Only then may an authenticated admin advance `system_generation`, and restore holds
   release only after every other applicable hold is reevaluated.

`docs/greenfield/restore-drill.md` is the rehearsed version of this.

## Escalation

Page immediately. Involve whoever authorized the restore, and do not let the
reconciliation be done by one person alone.

## What must stay held

- Sending and dialing stay held for the whole protocol. This is the single alarm where
  the hold is the entire point.
- Do not advance the generation to clear the alarm. Advancing it is step 9, not step 1.
- Do not resend anything the Sent-folder search found. A tombstone records that it
  went; it is not permission to send it again.
