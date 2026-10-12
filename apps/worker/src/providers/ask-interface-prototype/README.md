# Throwaway Ask interface comparison

Question: on identical supplied synthetic evidence, does a typed source/CRM observation projection and paragraph/reference output improve usefulness over the current Ask SDK protocol?

This branch is a prototype, not production implementation. It imports the pinned existing AI SDK and actual guarded Bedrock transport, but uses fixed in-memory synthetic evidence and tool snapshots. No PostgreSQL, Gmail, production configuration, sending, deployment or activation is involved. It does not test ordinary product commands, source deletion or real history discovery. The HTML's revoke/change/reset controls are illustrative only.

The six scenarios reuse the prior reviewed development labels. Original source text and scoped SQL snapshots are frozen in `fixtures.json`. Expected/forbidden labels and prior model answers never enter model requests. Both arms receive the same original facts and observations; the proposed arm changes projection, instruction and output shape together. Therefore this compares a bundle, not the separate causal contributions of each change. It cannot establish unseen or representative quality.

Use Sonnet 4.6's US profile, disabled thinking, the same provider-default decoding settings, 1000 output tokens and at most two generations per cell. Two repetitions and alternating arm order give 24 cells and at most 48 model calls. There are no automatic transport retries, critic calls, embeddings or extraction calls. An ambiguous call ends the batch and conserves its allocation.

Run a no-call inventory:

```sh
node --experimental-transform-types --disable-warning=ExperimentalWarning apps/worker/src/providers/ask-interface-prototype/run.ts --dry-run
```

Actual execution requires an exclusively claimed fresh scope bound to this source, fixture hashes and the existing explicitly approved synthetic campaign. The root runner validates the campaign reservation and requires `FSS_RUN_APPROVED_ASK_INTERFACE_PROTOTYPE=1` plus `FSS_PROTOTYPE_SCOPE_FILE`. It retains every conservative allocation before dispatch; the ledger is not an invoice. A consumed run cannot be replayed.

Build the shareable page from an actual result:

```sh
python3 apps/worker/src/providers/ask-interface-prototype/build_review.py RESULTS.json OUTPUT_FOLDER/review.html
```

Open the resulting HTML directly. It is self-contained, has no network/model calls and keeps interactive illustration state only in memory. Actual measured outputs remain immutable under illustration changes. Report business support, provenance, coverage, inferred-versus-stated conclusions, reference validity, readability, tool use, latency and allocation separately. No structural pass automatically approves usefulness.
