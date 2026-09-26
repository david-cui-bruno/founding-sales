# G3a: reassignment is admin-only, and reopening comes back manual

**Date:** 20 September 2026 · **Lane:** G3a CRM core · **Spec:** 5.2, 8.1, Appendix A

Two small decisions the specification left to the reader. Both went the conservative
way.

## Reassignment is admin-only

Section 5.2 lists "assignments" under what an admin manages, and gives a salesperson
"may modify, contact, or enroll only assigned firms". It does not say in so many words
whether an assigned salesperson may hand their own firm to a colleague.

`reassignFirm` refuses a salesperson with `admin_only` even for their own firm.
Reassignment changes who may contact a prospect and whose mailbox their mail comes
from; it creates a hold, cancels future work and transfers Today entries. That is an
administrative act in every sense the specification uses the word, and the cost of
being wrong the other way — a salesperson quietly moving a firm off their own list to
avoid a follow-up — is a silent gap in the daily work nobody would notice.

The refusal order matters and is deliberate: a salesperson who is *not* the assignee
gets `not_assigned` first, from `decideFirmMutation`, and only the assignee gets as far
as `admin_only`. So the admin-only rule never tells a stranger anything about a firm
they could not already read.

## Reopening creates a new opportunity, in manual mode

Section 8.1: "Reopening is an explicit command that either creates a new open
opportunity or reopens the existing one **under configured policy**; it never silently
restarts old automation." There is no configuration surface yet, so version one's
policy is fixed here:

* **a new opportunity**, linked to the closed one through
  `reopened_from_opportunity_id`, rather than un-closing the old one. The closed
  opportunity keeps its stage history and its close reason intact, and the pipeline
  dashboard's "stage movement" does not have to special-case a row that closed and
  then did not;
* **starting at the first non-terminal, non-retired stage**;
* **in `control_mode = 'manual'`**, with a reason naming the reopen.

The third is the one that makes the sentence true. An automated reopened opportunity
would be eligible for exactly the sequences that were running when it closed, which is
"silently restarts old automation" with extra steps. A person who wants automation
again enrolls a contact deliberately — which section 7.3 already requires after any
human reply, so this is the same rule rather than a new one.

`reopenOpportunity` refuses `opportunity_open_exists` when the firm already has an open
opportunity, and `opportunity_not_closed` when it has never had one to reopen.
