# G9: the board carries the opportunity ids the caller could act on, and no others

**Date:** 20 September 2026 · **Lane:** G9 · **Spec:** 8.1, Appendix F, Appendix G 7

G6 found that the pipeline board could offer a stage change only for a firm whose
page had already been opened, wrote the reason down in
`docs/archive/decisions/g6-pipeline-board-opportunity-ids.md`, and offered three resolutions
with no preference it could justify. This lane owns Appendix F's read matrix, so this
is the answer.

## The three options, and which one was taken

1. **Add `opportunityId` to `FirmIdentityDto`.** Rejected. That DTO is Appendix F's
   first row — what *any active member* may see about *any* firm — and it is also
   what CRM search and CRM export build. Widening it widens four surfaces to answer
   one, and the question G6 asked ("does a mutation handle belong in the
   colleague-visible read?") would have had to be answered yes for all of them.
2. **A board-specific read.** Taken. `POST /pipeline/board` returns the columns, the
   firms already placed in them, the firms with no open opportunity, and
   `opportunityIdByFirmId`.
3. **Leave it read-only.** Rejected: the board is where a person moves a firm along,
   and a board that cannot is a picture.

## The part that makes option 1's question unnecessary

The map carries an id **only for a firm this caller could change**: every firm for an
admin, assigned firms for a salesperson. So the handle is never in a
colleague-visible answer at all, and whether it would have been safe there does not
have to be decided.

That is strictly narrower than Appendix F row 1, and it is also more honest as a user
interface. A colleague's column renders G3b's `stage-change-unavailable` rather than
an enabled control whose click would be refused under the firm's row lock.

## What it deliberately does not do

It does not re-implement authorization. `mayChangeStage` in
`packages/domain/crm/board.ts` is a *presentation* question asked of a snapshot;
`decideFirmMutation` remains the decision, made under the firm's row lock at mutation
time. When the two disagree — a reassignment between the board load and the click —
the mutation wins and the person is told the firm is not theirs. A comment in the
file says so, because the two functions looking alike is exactly how somebody later
deletes one.

It is one read rather than one per column. N firm-page reads would also be N access
audit events for an admin (5.2), and loading a board is not N sensitive reads.

## The Mac keeps the old path

`createCrmBridge` falls back to `GET /pipeline/stages` and `GET /firms` when the board
endpoint does not answer, and merges any ids a Firm page told it about. A client
talking to an API that has not been deployed yet shows the columns without the
controls, which is the deployment order working rather than an outage.
