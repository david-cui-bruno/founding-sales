# G10: the repository contains no live provider adapter, and a test enforces it

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 7.4, 16.1

## Decision

`packages/domain/research/providers.ts` declares three interfaces — discovery, page
fetch, fact extraction — and the only implementations anywhere in the greenfield tree
are the recorded fixtures in `packages/domain/research/testing/fixtures.ts`.

The live adapters are not written. The worker's `registerHandlers` registers a research
handler only for the provider kinds the process was given, and this release gives it
none, so `research.page` and `research.firm` jobs wait in the queue unclaimed.

## Why an interface rather than a switch

The brief for this lane says "providers go behind interfaces with recorded fixtures; no
live calls in tests", and the obvious way to satisfy that is a flag: one adapter with a
`dryRun` mode, or an injected `fetch`. Both were rejected.

A flag is a thing that can be wrong. The old build's page provider took an injected
`http` function, and the production path and the test path differed by which function
was passed — which means the review question "can this call out?" has the answer "yes,
if the wiring is wrong". With no implementation in the tree, the answer is "not from
any code that exists".

## How it is enforced

`packages/domain/test/research/rules.test.ts` walks every `.ts` file under `research/`
and fails on:

* an import of `node:http`, `node:https`, `node:net`, `node:dns`, `node:tls`, `undici`,
  `@aws-sdk` or `node-fetch`;
* a call that looks like `fetch(`, or any mention of `XMLHttpRequest`;
* more than one file under `testing/`.

There is one permitted exception, and the test names it: `node:net` in
`sourcePolicy.ts`, for `isIP`, which recognises a literal address in a URL and opens
nothing.

The invariant-8 test adds a second sweep over the same files for outreach imports and
outreach table names, so a module that acquired the ability to enroll or send would fail
before its own tests ran.

## What the interfaces carry instead of code

The obligations the real adapter has to satisfy are written into the contracts, because
the old build learned each of them the hard way and a docstring is where that knowledge
survives:

* resolve the hostname, check **every** answer against `isPublicResearchAddress`, and
  pin the connection to the address that was checked — the DNS answer is
  attacker-controlled input, and without pinning "fetch the firm's website" is a
  request-forgery primitive pointed at the worker's own subnet and the instance
  metadata endpoint;
* refuse a redirect to anything `researchSourcePolicy` does not call a candidate;
* bound the response in bytes before decoding, and hash the exact bytes read, because
  the hash is the evidence item's identity;
* never supply a quote. Return `{ key, blockId }` and let `validateFactSelections` look
  the text up from the block, so a provider that paraphrases cannot be believed.

## What a recorded fixture is, and is not

It answers from responses written down in the file, in the shape the real adapter
produces. It fails the way a provider fails — a listing with no website, a page whose
bytes exceed the bound, a refusal with a code — and it returns the same bytes every
run, so a content hash is stable and the replay test can prove that a second run of the
same job creates nothing.

What it cannot imitate is the extraction provider's *judgement*, which is not
reproducible. So `recordedExtractionProvider` selects blocks by a deterministic phrase
rule, and what the tests pin down is the **admission** rule rather than the selection:
a selection naming an unknown block or an unknown key is refused and counted, and an
admitted fact's quote is the block's whole text. That is the part that has to be right
whatever the provider does.

Every name in the fixtures is invented, every host is under `example.test` (RFC 6761),
every number is in the NANP 555-01XX block, and every coordinate was chosen for which
side of a time-zone boundary it falls on.

## When the adapters are written

They are one object each, in `apps/worker`, reviewed on their own — because the review
that matters for them is a security review of a program that opens sockets to addresses
a prospect's DNS chose, and that review should not be buried in a change about
discovery semantics.
