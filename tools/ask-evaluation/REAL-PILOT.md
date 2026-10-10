# Bounded real CRM/Ask diagnostic

This opt-in runner is tooling for #497. It does not enable capture, processing, Ask,
outreach or any provider purpose. The current business-corpus/purpose/budget proposal
still requires human approval. No business manifest or real result is supplied here.
The existing fake evaluation manifests, split, scripts and reports stay frozen.

Run controlled checks with `npm run test:ask-evaluation`. This is part of `npm test`
and `npm run gate:greenfield`; exact SQL runs in disposable PostgreSQL. The controlled
SDK/source adapters in these checks establish orchestration, not semantic quality.

## Preparing and executing one approved run

1. Obtain at most four approved business sources through the existing authenticated
   canonical reads. Freeze their exact workspace/source/kind/revision/content-hash/
   locator tuples and each window's original UTF-8 SHA256 using `pilotHash(text)`.
   At most twelve windows are permitted. Do not substitute operational mailbox bodies
   or a source selected for another purpose. All source metadata must match normal
   reads; partial capture is not proof of a complete original.
2. Independently preregister up to three questions, relevant window IDs, acceptable
   literal claims/citations and required abstentions before any candidate output.
   The manifest records the label author, time, chunker, text-group deduplication,
   models, exact decimal-string rates, verified price time, dimensions and ceilings.
   Labels are binary relevance; reported nDCG is binary-label nDCG at ten text groups.
3. Independently verify the reviewed manifest hash, actor, original/current ownership,
   provider purpose/access/retention, worst-case priced spend and the one approved
   ledger absolute-path hash. Implement `PilotPorts.verifyAuthority` from that evidence.
   A declaration in the manifest is not authority. The verifier must refuse a different
   ledger path, rather than granting another $1 run. No credential belongs in the
   strict manifest, receipts, label metadata or error text.
4. Supply `readSource` as `/crm/processing/source/read` with its flat public lookup,
   and `readAsk` as `/ask/read`, through the approved authenticated read client.
   The runner rereads exact source/hash/window bindings before every external call,
   after external waits and before releasing each answer diagnostic.
5. Supply `createRealPilotSqlRanker` with a disposable PostgreSQL session. Provide
   `createTitanPilotTransport` with the explicit `loadTitanPilotSurface('us-east-1')`
   only after authority passes. The SDK has one attempt, no retry. Wrap the existing
   bounded Bedrock Ask adapter using `createPilotAnswerTransport(adapter, 'real')`.
   Real Titan dimensions must be 256, 512 or 1024. Controlled transports must retain
   their controlled label; selecting a real model name does not make fake data real.
6. Call `runRealPilot(reviewedManifest, approvedLedgerPath, ports)`. The parent
   directory must already exist. Review the returned body-free report and keep the
   private manifest/labels under the corpus's approved retention/deletion policy.

The allowed real models are Titan Text Embeddings V2 and the proposed US Haiku4.5
inference profile. Only those identities are accepted; their current rates are not
hardcoded or represented as verified by these tests. Price snapshots expire after
seven days and the independent authority verifier must recheck current applicability.

## Comparison and financial contracts

The actual public keyword response must scan the complete explicit frozen source
corpus without truncation, refusal or extra windows. Every returned passage joins
exactly to a canonical frozen window. A transcript larger than the twelve-window
pilot cannot silently become a selected-subset keyword baseline; narrow the approved
corpus or report the diagnostic unavailable. No missing-hit counts are invented.

The same permitted windows receive exact SQL cosine ranking, text-group maximum
member scores and RRF with constant60. Reports distinguish lexical, controlled/real
exact-vector and controlled/real hybrid paths, with recall, precision, binary nDCG
and stage latencies. These are bounded diagnostics, not population accuracy or
production ANN/load measurements. Unknown supported paraphrases remain unjudged;
matching a literal source excerpt alone does not make it a preregistered gold claim.

A local financial ledger acquires an exclusive file lock and fsyncs reservations
before transport dispatch. It uses the product's `crmTokenCostCents` exact pricing
and rounds only at final cents. Answer reservations bound the same serialized
question/windows/groups body used by the answer adapter plus 1,024 system bytes and 1,024 framing bytes. The full planned worst-case
reservation must fit before any call; each dispatch rechecks remaining budget.
Limits are four sources, twelve windows, three paid questions, twenty-five attempts
and100cents. The normal plan needs window-count plus twice question-count calls.
No top-ups, product budgets or provider grants are created.

Ambiguous acceptance, timeout, unknown/malformed usage or token overshoot conserves
that whole reservation and stops. A restart does not retry; incomplete runs with
settled calls also refuse automatic resumption. Corrupt ledgers are never overwritten.
Concurrent/stale locks refuse execution; there is no automatic stale-lock deletion.
Reviewing/restoring such a lock or reservation is an explicit operator recovery,
not authorization to create a replacement ledger and redispatch.

The ledger contains no source bodies, vectors, generated claims or raw SDK errors.
It records frozen-manifest identity, financial states and body-free metrics only.
Source bodies and embeddings are held only during execution. Local private manifests
and labels still require their own approved erasure/retention handling. This diagnostic
never publishes product claims or proves production support/deletion acceptance.
Every result has `activationAllowed: false`.
