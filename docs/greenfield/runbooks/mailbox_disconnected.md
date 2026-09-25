# mailbox_disconnected

**Metric:** `MailboxDisconnectedHours` · **Severity:** critical · **Spec:** 12.6, 13.3

## Symptoms

A mailbox that sent in the last 30 days has had its Gmail grant revoked (`status =
'revoked'`) for 48 hours: Google refused the refresh token, or the owner departed. Every
automated step kind for that owner is held (12.6), and replies to mail FSS already sent
are not being read.

A mailbox its owner disconnected with the disconnect command (`status = 'disconnected'`)
is not counted since lane g81: that was a choice, and the owner's work is held for it
the same way without anyone being paged.

## First checks

1. `GET /diagnostics` as an admin: the mailbox's status, `disconnect_reason`,
   `disconnected_at` and coverage watermark.
2. `GET /gmail/status` for the owner, and whether they still have a Callie Workspace
   account.
3. Whether the disconnection was deliberate — a departure revokes membership, devices,
   sessions and OAuth grants and deletes refresh-token material (10.3).

## Diagnosis

- **Grant revoked by the person or by Workspace admin:** expected after a departure,
  otherwise usually an accidental revoke in the Google account console.
- **Token decryption failing:** the envelope key changed or the KMS grant was lost.
  This looks like a revocation and is not one; the log names the stage.
- **Disconnected by FSS** after repeated provider refusals.

## Safe recovery

- The owner reconnects through `/gmail/connect`. The connection completes a bounded
  baseline before automation resumes; the health hold clears only when coverage is
  proved for the whole interval, never after one successful API call.
- If the person has left, reassign their firms. Reassignment transfers firm business
  data to the new assignee and future work rebinds to the new owner's mailbox;
  dispatching mail remains with the former mailbox and reconciles there (Appendix A).
- If the envelope key is the cause, repair the KMS grant; do not re-prompt the
  salesperson for a grant that is not actually broken.

## Escalation

Escalate after 48 further hours, or immediately if the mailbox has unresolved outbound
fences: those reconcile through the Sent folder of *that* mailbox and cannot be
resolved from another.

## What must stay held

- The owner's automated steps stay held until coverage is proved. This is the hold the
  alarm is about; releasing it by hand is how a firm gets mailed after it replied.
- Do not repoint the enrollments at another salesperson's mailbox to keep sending.
  Automated sequence mail uses the assigned salesperson's mailbox (12.1), and a
  reassignment is an audited command, not a workaround.
