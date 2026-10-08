# Automatic email admission evaluation

#423 adds a reproducible offline diagnostic through the agreed worker/database seam. It does not enable or deploy admission. The schema62 activation block and normal `activation_not_available` response remain unchanged.

## Run and inspect

Use Node24 and the installed workspace dependencies. Commit the evaluated source first, then run from the repository root:

```sh
npm run evaluate:email-admission -- /absolute/path/to/new-evaluation-directory
```

The command refuses tracked changes and untracked code. It creates a new directory exclusively, starts the existing disposable PostgreSQL test cluster, runs the admission integration suite, and records each labeled case's actual admission/refusal and successful rank. It has no production database connection, crawler, search client or real send adapter. Existing sender tests use the recorded Gmail fake. It cannot force discovery, reset quotas or enroll a production prospect.

Review these artifacts together:

- `report.json`: exact forty-character implementation commit/tree, policy and prompt versions, prompt source digest, corpus digests, provenance, original source timestamps/content hashes, selected block IDs, expected/actual cases, actual refusal reasons, rank and integration test results.
- `report-digest.json`: SHA256 of the exact report bytes. The report excludes its own digest to avoid a self-reference.
- `controls/disabled-control-receipt.json`: a second disposable-database pass saves that report digest through `saveEmailAdmissionControl`, reads it back, and verifies that an enable request is still refused.
- `activation-input.json`: normal control input with `enabled=false`, exact report digest and **disposable fixture** configuration binding/IDs. `productionReady=false` is explicit. Never submit these fixture IDs to production.

Failed, missing or mismatched cases, failed guards, unexpected ranks, unresolved false eligible results or an empty source-reviewed positive set prevent creation of the activation input. Failed evaluation still retains its diagnostic report where the test process could complete. Reusing a directory is refused; fix and rerun with a newly committed exact implementation. If extraction/policy/runtime code changes, old evaluation metadata cannot authorize the changed commit.

## Labels and scope

The committed corpus refreshes the evaluation of the six selected October7 first-party extractions: NHS, Nexus, Key, RentProv, Lyon and Zanno. Original candidate/run IDs, bounded observations and selected facts are retained. Five cases retain v6 selections with an unchanged prompt source. Zanno originally used `qualification-email-v2`; it was refetched and extracted with the current v6 bounded qualification runner in an isolated database on October8 (one cent recorded against a five-cent evaluation ceiling; no discovery). The refreshed Zanno evidence still lacks resolved identity/residential/geography support and publishes an email on a different host. A frozen database decision clock of October8 00:55UTC makes source replay reproducible without pretending to refetch a page. Later execution dates do **not** renew the original source timestamps or measure new stochastic extraction performance.

Key and RentProv are supported fit-only examples. NHS/Nexus/Zanno lack resolved identity/contact evidence; Lyon includes truncated evidence, a search-title identity mismatch and a street address selected as business email. Those four must defer. RentProv's Head of Maintenance is context, not an exclusion or unmet-need claim. Key is replayed only in a disposable database; the integration suite separately preserves an existing original manual enrollment and scheduled execution.

Twenty-six separately labeled synthetic cases cover TX/RI/MA positives, unsupported geography and commercial/navigation-only evidence, mismatched identity/hosts, third-party/truncated/stale/future observations, vendor/consumer/guessed/ambiguous/unnamed addresses, supported named contacts, contrary need, fit without pain, team/software context, current help and expired/undated events. Their review notes explain expected behavior independently of the predicate. A future-dated observation is refused at evidence intake; the harness records that stage rather than loosening validation to reach admission.

The existing fifty real-database integration checks exercise the admission and sender boundaries: live owner/mailbox/sequence bindings, stops, holds, deduplication and replay, atomic rollback, sender capacity/health, ranking and bounded scheduling, final dispatch safeguards and observable outcomes. Passing the text predicate alone is never counted as safe admission evidence.

This is a selected diagnostic sample, not population precision, recall, discovery yield, inbox placement, conversion or a representative market study. Synthetic cases are not leads. `reviewedEligible` counts only correctly admitted recorded-source positives; failures and false eligible counts remain explicit. A zero observed false eligible count is necessary, and is not sufficient activation evidence.

## Production binding and activation remain conditional

The generated input demonstrates normal disabled-control compatibility in isolation. #425 must rerun the evaluator on the exact final deployed commit, read the real current owner/mailbox/approved-sequence configuration and revision through normal controls, and bind the report digest to that `configurationSha256`. A PR commit and its later merge/release commit are different identities: identical code does not waive rebinding. The normal control implementation rejects an implementation/configuration mismatch.

Production admission remains off. Before activation, #424/#425 still require normal exact-commit release/schema/smoke/readback verification, actual sender allowance/holds/unsettled-state verification, received SPF/DKIM/DMARC alignment from the actual sender, durable evidence for Shirley's original send, and cadence/reply/booking interruption evidence. Preserve ordinary discovery budgets, initial sender ramp, original Shirley enrollment, routine replies off and no autonomous calls. Live qualification/admission independently rechecks source freshness; replay is not permission to reuse stale evidence.
