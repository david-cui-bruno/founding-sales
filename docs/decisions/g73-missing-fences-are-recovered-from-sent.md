# g73: missing fences are recovered from the Sent folder

Lane g73, 25 September 2026. Decides how Appendix E step 3 finds a send whose fence a
point-in-time restore lost, what it records for it, and what it does when it cannot
tell which step the send was.

## The gap

Specification revision 3, Appendix E.3: "Search every mailbox Sent folder from the
restore point minus ten minutes for FSS Message-IDs; insert sent tombstones for missing
fences."

`fss admin mailbox reconcile-sent` did the first half only for fences the restored
database still had. It selected fences in `dispatching` or `reconciling` and asked Gmail
about each one by its Message-ID (`reconcileOutboundMessage`). A send made after the
restore point has no fence in the restored copy, so nothing asked about it. Its step is
pending again in the restored copy. The sender's dedupe key is one fence per step
execution (`outbound_messages_one_per_step_execution`, read by
`prepareOutboundMessage`), and that fence is what the restore lost. So the restored
sequence would have prepared a new fence and sent the same email again.

The drill did not show it. Its step 3 assertion is `tombstones >= 1`, and the in-flight
seed leaves a fence the restored copy still has, `reconciling`, with its Message-ID in
the recorded Sent folder. The `after` phase's send went to a firm made after the restore
point, so its loss left nothing that could send again either. The independent review of
25 September (`GPT6-SOL-FULL-20260925`, section 1 row 2) marked it P1 before automated
sending.

## The marker

Every FSS send carries a deterministic Message-ID, `<fss.{fence uuid}@{sending domain}>`
(`deterministicMessageId`). The fence writes it before the one Gmail call, and the MIME
builder copies it verbatim. Gmail mints `<CA…@mail.gmail.com>` for anything it composes,
so a person's own mail never has it.

The marker is the **whole** id, domain included: `fssFenceIdOfSentMessage(header,
mailboxAddress)` accepts the `fss.<uuid>` shape only at the domain of the mailbox whose
Sent folder it is reading, which is the domain `prepareOutboundMessage` wrote. A message
with the shape at another domain was not written by FSS for this mailbox. It could be a
copy, a forward that kept the header, or another system's scheme, and step 3 must not
turn it into a tombstone that stops a real step from sending. Subjects and bodies are
never read to decide what a message is.

## Decision

Step 3 now has two halves, in this order:

1. **The fences the copy still has** — unchanged. Every `dispatching` or `reconciling`
   fence since `--since` goes through `reconcileOutboundMessage`.
2. **The Sent folder** (new). Each connected mailbox's Sent folder is listed from
   `--since` to now (`GmailClient.listSentMessageIds`, `in:sent` with epoch-second
   bounds, trash included). Each message's metadata is read with a three-header
   allowlist: `Message-ID`, `To` and `Subject`. Its body is never read. The messages
   carrying the marker are handed, oldest first and one transaction each, to
   `recoverSentFolderMessage` (`@fss/domain/restore`). The Gmail half,
   `scanSentFolder`, lives in `@fss/domain/outbound`, which imports nothing of the
   sequence lane's. The database half lives in `restore`, which already composes the
   lanes for Appendix E.

The window's lower bound is `RESTORE_SENT_SCAN_SKEW_SECONDS` = 600 before the restore
point. That is Appendix E.3's ten minutes. Gmail dates the message and PostgreSQL
commits the fence after the call returns, so a message dated seconds before the point
can belong to a fence whose `sent` the copy never saw. The ten minutes also cover clock
skew and RDS's up-to-five-minute restorable lag. Reading earlier costs only metadata
reads, because every older message finds its fence `present`.

Each FSS message gets one of five outcomes:

| Outcome | When | What is written |
|---|---|---|
| `present` | the copy has the fence, dispatched or terminal | nothing |
| `pre_dispatch_marked_sent` | the copy has the fence `prepared` or `held` | the fence walks `held → prepared → dispatching → sent` with Gmail's instant and ids, its cap/window holds are released, and its step is completed |
| `tombstoned` | no fence, and exactly one step is the send's | a `sent` fence on that step, and the step completed |
| `unmatched` | no fence, and no live enrollment reaches the recipient | nothing; reported |
| `unattached` | no fence, a live enrollment reaches the recipient, and no single step can be named | nothing; an unresolved exception |

### The tombstone

It is an `outbound_messages` row, not a new table. The table requires exactly one
origin, so a tombstone needs a step execution. That is also what the sender's dedupe key
reads, so a tombstone on the step is what makes `prepareOutboundMessage` return the
existing fence (`created: false`) and `dispatchOutboundMessage` answer
`already_terminal`. No migration, and no change to the sender, is needed. The domain
test `test/restore/missingFences.test.ts` proves it: it runs `runDueStepExecution` and
`dispatchPreparedStep` over the real fence, and the control (the same step, no
tombstone) records one Gmail send where the tombstoned step records none.

The row carries:

* the lost fence's **own id** (the uuid in the Message-ID) and its Message-ID, so the mail
  pipeline recognises the message as FSS's own (`fenceForOutgoingMessage`) when step 4
  ingests it, and a reply or bounce that references it finds it (`originatingSend`);
* `state = 'sent'`, inserted directly with an unused attempt token. `sent` is terminal,
  and no transition into it would not claim a Gmail call happened now;
* the enrollment, step execution, firm, contact, opportunity and route of the step;
* Gmail's message and thread ids, and Gmail's internal date as `dispatch_started_at`,
  `sent_at` and `send_at`, so a successor is placed from the original send;
* the workspace business date of that instant, which 12.7's bounce attribution reads;
* the Sent message's Subject (one line, bounded), and a fixed body saying it was
  recovered and not copied, because step 3 never reads the body;
* `placement_rule_version = 'restore-tombstone.1'` and `source_zone = 'UTC'`, because no
  placement rule placed it;
* a ledger event `null → sent` whose detail says `reconciled_from:
  'sent_folder_missing_fence'`. That event is the audit record.

`INSERT … ON CONFLICT DO NOTHING` covers every unique key, so a second pass, or two
racing passes, insert nothing and answer `present`.

### Which step

The send is attributed by its recipient and its mailbox, the only two facts the Sent
folder states about it besides the marker:

* the recipient (the one address in `To`) is a route of **exactly one** live
  enrollment's contact. A contact has at most one live enrollment
  (`sequence_enrollments_one_active_per_contact`), and FSS sends to one address;
* that enrollment is assigned to the **mailbox's owner**, who is the sender
  `prepareOutboundMessage` resolves;
* its **next unfinished step** is an email step with **no fence**. A successor step does
  not exist until its predecessor completes, so this is the step that was due.

The step is then completed with `completeEmailStep(…, 'sent', at: Gmail's instant)`,
the call `dispatchPreparedStep` makes when it reads a `sent` fence. So the restored
sequence stands where it stood before the restore. The next step is created and placed
from the enrollment's start, as it would have been. That is also what handles a restore
that lost two sends of one enrollment. The messages are answered oldest first. The first
completes step 1 and creates step 2, and the second then finds step 2 as the next
unfinished step and is tombstoned on it.

### When no single step can be named: fail closed

A tombstone needs a step, and guessing one could suppress a step that was never sent.
Not guessing could leave one that was sent free to go again. So step 3 does neither:

* **`unmatched`** — no live enrollment reaches the recipient. The prospect or their
  enrollment was created after the restore point too, and nothing in the restored copy
  can send to them automatically. This is reported and left. The drill's existing
  `after` send is this case.
* **`unattached`** — something could send to the recipient, but the step is ambiguous:
  two live enrollments reach the address, the enrollment belongs to someone else, its
  next step is not an email step, the next step already has a fence under another
  Message-ID, or `To` is not one readable address. Step 3 lists it, and the step 8
  report turns it into an unresolved exception (`unattached_sent_message`), which
  `verifyRestoreReport` refuses. The restore holds stay on until an operator acts: they
  stop or complete the enrollment the send belongs to, then re-run steps 3 and 8. After
  that, nothing live reaches the recipient and the send is `unmatched`.

A Sent folder that could not be read to the end (a revoked grant, a rate limit, more than
`SENT_SCAN_PAGE_LIMIT` pages) is the same kind of exception, `sent_folder_unscanned`.
Such a folder has proved nothing about the part it did not read.

### The pre-dispatch case

This is the same failure with the fence present. The restore point fell between a
fence's preparation and its dispatch: a fence was held by the day's cap at 16:59, then
released and sent the next morning after the point. The copy holds it `prepared` or
`held`, and the dispatch path would claim it and send it again under the same
Message-ID. The machine has no `prepared → sent` edge, so the fence walks the edges it
has. Each move gets its ledger row, and the claim is the same atomic
`WHERE state = 'prepared'` the dispatch path uses.

## Reporting

`sent-reconcile.json` (the step 3 report) gains `fences_reconciled` (the old
`tombstones`, which is kept under that name for step 8 and the release record),
`missing_fences_tombstoned`, `pre_dispatch_fences_marked_sent`,
`missing_fences_unmatched`, `missing_fences_unattached`, `mailboxes_unscanned`, the
Sent-folder counts, and `missing_fences`, one line per FSS message. The report is kept
as a release artefact, so a line names the message only by the first sixteen hex digits
of its Message-ID's SHA-256 and never names the recipient.

The drill gains two checks. `step3-missing-fence-tombstoned` reads each reported
tombstone back from the database: one `sent` fence, alone on its step, with the
Sent-folder provenance. `step5-no-second-send` runs after the jobs are rematerialized.
Each tombstoned step still has its one fence, its recipient has no more fences than step
3 left, and nothing in the drill sent mail. The `after` phase now sends a step the
`before` phase enrolled, in a sequence whose one step is due thirty days out. Nothing but
the seed sends it, and the restored copy holds it pending with no fence.

## What this does not do

* **The daily cap of the send's day is not re-counted.** The restored copy lost the
  increment. A restore on the same business date could allow one more automated send
  than the cap. The count is a CHECK-bounded counter whose day may already be at its cap,
  and the tombstone is the at-most-once guarantee. The cap is pacing.
* **No body is copied.** The real body is in the mailbox, and step 4 ingests the message
  into `mail_messages` like any other.
* **An enrollment created after the restore point, for a contact the copy knows, is not
  recreated.** It is `unmatched`. A salesperson who re-enrols that contact after the
  restore would start a new sequence. That is a person's act, and the message is in the
  thread they can see.
