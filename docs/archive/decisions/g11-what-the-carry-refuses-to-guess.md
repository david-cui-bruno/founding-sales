# G11: what the carry refuses to guess, and what it fails on

The specification names four kinds to carry and says nothing about what to do when
one of them cannot be read. Every one of those silences is resolved the same way:
**fail the run, never drop the record.**

## An unreadable record fails the export

The old worker skipped a row its schema refused — "a row the schema refuses is
skipped, never coerced" is a comment in `v1/firms.ts`. That is correct for a read
model that is rebuilt on every request and wrong for a carry that happens once. A
firm silently dropped here is a firm nobody ever calls again; a suppression silently
dropped here is invariant 4 broken in a way nothing downstream can detect.

So `readOldRecord` refuses, `runCarryExport` counts the refusals per kind, and the
run ends with `record_unreadable` and no artifact. David fixes the record or this
reader and runs it again, which costs minutes, before anything has been written.

The same holds at import: a firm-scoped suppression whose firm did not come over is
`suppression_firm_absent` and rolls the whole transaction back. There is no code path
in this lane that discards a suppression.

An `sk` the carry does not read — `CAMPAIGN_ENROLLMENT#`, `EVENT#`, `GOOGLE_GRANT#`,
`COUNTER#`, everything else — is skipped silently, because those kinds are not part
of the carry at all. Postures are in that set: section 2 carries firms, evidence,
suppressions and template bodies, and **postures are never copied**. The old
territory clearances are a legal posture the founder records deliberately in the new
system (invariant 7), not a row a tool moves.

## A post-watermark record fails the export *and* the import

Appendix G 20 is checked twice, because the two checks catch different things.

At export, a record whose own instant is after the watermark means the schedule was
not actually stopped. The run ends with `post_watermark_items_present` and per-kind
counts. There is no `--accept-post-watermark`: a carry that could be forced past this
is a carry with no watermark.

At import, the same comparison is made against the watermark recorded *in the
manifest*, so a hand-edited artifact cannot bring a post-watermark record into the
new stack. This is the one check that is deliberately duplicated.

## A refusal names counts, never values

Every refusal from the export and the import carries per-kind counts and closed
codes. Never a sort key, a firm id, a handle, a name or an address: a refusal is
printed to a terminal and pasted into a message, and an operational message about a
carry is not a place for a prospect's number.
`apps/worker/test/carry/export.test.ts` asserts that a refusal over a table
containing `account-echo` and `+1401555…` contains neither string.

## A route the greenfield validators refuse does not fail the run

The one exception, and it points the other way on purpose. A carried phone number or
address that `addPhoneRoute`/`addEmailRoute` refuse is reported and the firm is
carried without it. A route is recoverable by hand from the evidence in one minute; a
firm dropped from the carry is not recoverable at all, because the old stack is
read-only from the watermark onwards and nobody will look at it again.

Carried routes arrive as `candidate` whatever the old record said about them.
Eligibility is `decideRouteEligibility`'s decision and never the caller's: the old
table has neither technical validation nor association confidence, so `source:
'import'` is the honest word and a candidate is the honest state.

## The evidence excerpt travels; the provider name is not invented

`evidence_items` gets one row per source of each old `EVIDENCE#` record, with
`source_reference` = the URL, `content_hash` = the recorded sha256, `retrieved_at` =
the recorded fetch instant, and the excerpt in `detail`. The provider is
`legacy_research`, because the old record names the pages it fetched and does not
name a provider per page; inventing one would be a citation the record cannot
support.

The excerpt is kept rather than dropped because it is the part of the old evidence
David actually reads when he personalises a first email, and retention (lane G14)
governs `evidence_items.detail` like any other evidence detail — "research evidence:
with the firm while provider terms permit" (10.3), which is the row's own rule and
needs no exception for the carry.
