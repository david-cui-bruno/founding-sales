# Ordinary-worker Sonnet/Haiku comparison — October 12, 2026

## Outcome

Both approved synthetic runs completed on frozen source `2d612dc201c585e8782c3c87c7572bb7e957bfc6` (tracked working-source SHA `e519fb4134782ed57c5282803ab7afabd0be0ab0aa87a1a8278e4cc4fced4863`). The ordinary configured SDK and registered worker published two of eight Sonnet answers and four of eight Haiku answers. Test-run completion is not answer usefulness or ticket acceptance. #551 remains open.

| Model | Published | Unavailable | Stale | Calls including probe | Conserved allocation |
|---|---:|---:|---:|---:|---:|
| Sonnet 4.6 | 2/8 | 6/8 | 0/8 | 12 | 146c |
| Haiku 4.5 | 4/8 | 3/8 | 1/8 | 13 | 56c |

Both correctly answered the exact-state questions: three open opportunities (excluding one lost record), and two open tasks due by the specified cutoff. Haiku also published the copied-note coverage and reported-request cases. Sonnet emitted explicit empty exact-reference arrays in all six source-only drafts; those drafts were refused as `unsupported_answer`. Haiku did the same in three refused drafts. Its ambiguous-pilot case became `stale/source_changed` after requesting `resolve_records`, before any tool execution or answer.

## Interpretation review

Review actual published results separately from private native drafts. Several refused drafts contain useful summaries, but they are not successful product answers. Sonnet's Cedar draft wrongly infers that texts were not captured anywhere in the CRM from a note saying no texts were copied into it. Sonnet's Juniper draft equates the promised Thursday with October 1 without adequate evidence. Haiku's Harbor draft shifts “next week” from the offered demonstration onto sample sending. Haiku's Elm answer adds an awkward, unnecessary statement about the sender identifying as “We.” These are semantic/style issues independent of publication plumbing.

This eight-case, one-answer-per-model synthetic comparison cannot establish representative reliability or rank the models generally. Correct citation membership does not prove semantic support. Thinking stayed disabled; no vector retrieval or reasoning comparison occurred.

## Controls and accounting

The approved combined ceiling was 34 calls/$10; each immutable scope allowed 17 calls/$5. Actual dispatches were 25, with 202c conservative allocation retained. Allocation is not the provider invoice. Both grants are consumed; no automatic retry or replacement run occurred. The source scopes, owner receipts, native request/response captures, per-case reads, diagnostics and post-deletion readbacks remain under `.context/ask-contract-v4-comparison-20261012/` and the two immutable run directories.

- Sonnet run: `410e252f-9774-42fa-ae79-8ce1c47e24f1`, scope SHA `085b10699cdeea2235bcd94dfcac6b67c152bc921a4e710d2fc94ff01bb81a5d`.
- Haiku run: `b0351a53-762b-4dbf-89bc-2b88e2fae9f8`, scope SHA `d9bc235a2032eb8ec2acb26a1eab276471f8f6a94f47079f9c64a19dd56b1aaf`.
- Labels SHA: `8d1416cb7461a7f079a1e5a4d8ea9b80bfc307ba4dd69155f2741fa916687d61`.

All fourteen cases with source-backed cleanup retained post-deletion evidence with question, answer and fallback erased; source-free opportunity cases retained their legitimate answers until disposable database teardown. No Gmail/customer text, production rollout, activation or sending occurred. The release hold and sending safeguards remain.

## Next action

The SDK/worker empty-reference mismatch is repaired in source by allowing the optional empty exact-reference list while retaining the original-or-exact authority requirement. A configured-SDK/registered-worker regression failed for the supported empty-list case before the change and passed afterward; the no-evidence controls still refuse. All 31 focused tests passed, and separate offline replay accepted all six captured Sonnet source drafts with original navigation/deletion intact. That replay establishes structural publication, not semantic correctness. Diagnose the independent record-resolution stale outcome. Actual repaired-source model usefulness remains unmeasured; offline replay of captured drafts will not retroactively turn this failed comparison into a successful run.
