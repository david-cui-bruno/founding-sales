# g76: history records are the unit of progress

Lane g76, 25 September 2026. Audit items C06 (P0), C07 (P0) and C08 (P1) of the
25 September exhaustive review. Decides what a capped `mail.sync` may claim to have
read, and how history ids are compared. Amends
`docs/archive/decisions/g7-sync-transaction-shape.md`, whose bound is unchanged.

## What was wrong

**C06.** `users.history.list` answers `{ history: History[], nextPageToken, historyId }`,
and a `History` is `{ id, messages, messagesAdded, messagesDeleted, labelsAdded,
labelsRemoved }`
(https://developers.google.com/gmail/api/reference/rest/v1/users.history/list,
https://developers.google.com/gmail/api/reference/rest/v1/users.history#History). The
adapter read each record's id from `historyId`, which is a field of the `Message`
resource and never of `History`, and fell back to the start cursor. The unit fixture
put `historyId` on the record, so the test agreed with the adapter and not with Google.
Under the cap nothing showed: the run wrote the top-level `historyId`, which is right.
A capped run computed its cursor as the highest record id among the messages it took,
which was the start cursor every time, so it wrote back where it began. A mailbox more
than 50 messages behind re-read the same first 50 every minute and never reached the
51st, until Gmail expired the cursor and a recovery re-read the interval.

**C07.** Correct the field and a second fault appears. The run flattened records into
per-message entries and sliced the first 50. When the 50th fell inside a record with
several messages, the cursor stood on that record's id with the rest of its messages
unprocessed, and `startHistoryId` returns only the records *after* an id. Those
messages would never be read by a sync.

**C08.** The cursor was maxed with `Number(id) > Number(highest)`. Gmail history ids
are uint64 decimal strings, and `Number` is exact only to 2^53 - 1: `9007199254740992`
and `9007199254740993` are the same `Number`. The recorded fake ordered and filtered
the same way.

## Decision

1. **The adapter reads `History.id`, and a record with no usable id is a malformed
   page.** There is no cursor such a record could safely stand for: the start cursor
   stalls the mailbox, and any later id skips the record. The page fails, the job's
   retry ladder decides, and nothing is written.
2. **A run takes whole history records, oldest first, until it holds 50 distinct
   messages, and never part of one** (`takeWholeRecords` in `mail/sync.ts`). A capped
   run writes the id of the last record it took. The first record is always taken
   whole.
3. **Every comparison of two history ids is `BigInt`,** through `compareHistoryIds` and
   `laterHistoryId` in `mail/historyIds.ts`, in the sync, the fake and the drill's
   recording. Ids are read as strings matching the column's own `^[0-9]{1,20}$`, and a
   JSON number only while it is a safe integer. `mailboxes.history_id` is `text` and
   stays `text`: it already stores exactly what Gmail sent, and nothing here needs a
   migration.

## Why whole records, and not intra-record progress

The alternative is to keep the per-message cap exact and persist how far into a record
the run got: the record id plus an offset, or the set of its messages processed.

* **It needs a schema change and this does not.** A new column on `mailboxes` is a
  migration, and under the 25 September release cadence a migration is a full
  rehearsal. The whole-record rule is app-only: a worker deploy and a smoke.
* **An offset into a record is a position in a list Google does not promise to replay
  in the same order.** The documentation promises the order of records ("History IDs
  increase chronologically") and says nothing about the order of `messagesAdded` and
  `labelsAdded` inside one. A stored offset would be a guess about that order; a
  stored set of message ids would be unbounded state kept to save a few metadata reads.
* **The cursor keeps one meaning.** Every cursor in `mailboxes.history_id` is a Gmail
  record id, and "past this id" means "every message in every record up to here was
  processed". The compare-and-set, the watermark rule and the recovery all rest on
  that, and a cursor that could mean "half of this record" would need each of them
  re-read.
* **The cost is bounded by one record.** A run can go past 50 by one record's messages
  less one. A new message is ordinarily one record of its own; a label applied to many
  messages at once is the ordinary way to get a larger one, and Google documents no
  upper bound on a record's size. The cap exists to keep the runner's transaction short
  (g7). One record's metadata reads are expected to fit the five-minute lease that
  decision chose; that is not measured, and a lease that did expire would only have a
  second worker redo work the uniqueness collapses (`mail/handlers.ts`).
* **Re-reading is already safe.** Every write the pipeline makes is `ON CONFLICT DO
  NOTHING`, an upsert, or looked up by message first (`recordMatches`), because
  recovery overlaps sync by design (`mail/effects.ts`: "what makes `mail.sync` safe to
  run twice"). If Google's
  `startHistoryId` turned out to be inclusive rather than "after", the cost would be
  one record re-read per capped pass, and nothing skipped.

## What the fix does to a mailbox that is behind today

The old code never moved a cursor past a message it had not processed. A run that hit
the cap wrote the cursor it began from; a run that did not had taken every record it
read and wrote the top-level id. So a production cursor that was stuck is *behind*,
not ahead, and nothing between it and the present was skipped by a sync. On the first pass after the
deploy the run reads from that cursor, re-processes the first 50 once (no new rows),
and moves forward record by record, one pass a minute, until a pass reads to the end.
Only that pass raises the watermark. If Gmail expired the stuck cursor first, the
404 had already started a recovery from the frozen watermark minus an hour, which
covers the same interval by date.

## How it is tested

`packages/domain/test/mail/httpClient.test.ts` feeds the adapter a page in the
documented shape (two records, one with two messages, no `historyId` on any record),
a uint64 id, and the old fixture's shape, which is now refused.
`packages/domain/test/mail/historyCursor.test.ts` tests the rule on its own; a capped
sync on a real database whose cap falls inside a three-message record; a cursor walked
across `9007199254740992`, `…993` and `…994`; and a capped sync through the real HTTP
adapter over a loopback server answering in Google's shape. Three mutations in
`scripts/releaseMutationCheck.mjs` put back each defect and must be killed.
