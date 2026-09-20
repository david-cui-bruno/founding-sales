# Research: discovery, enrichment, evidence and suggestions

Specification revision 3, invariant 8, sections 7.4, 9.2, 10.3 and 13.2, and
Appendices C, D and G 37. This is how firms get into the system and how what is known
about them grows, and — just as importantly — everything that does not happen as a
result.

## The short version

Research **discovers** firms through an approved provider and **enriches** the ones
that exist. A discovered firm arrives unassigned, with no opportunity, with its listed
number as a `candidate` route, and with its time zone resolved from its coordinate.
Enrichment reads the firm's own pages, records them as evidence, and records everything
it learns as a **suggestion** — including the one business email it found and every
fact it could quote.

Nothing research does contacts anybody. A suggestion is inert. A candidate route is
not dialable. A discovered firm is on nobody's list until an admin assigns it.

## Where everything is

```
packages/domain/db/migrations/0005_research.sql  the tables, seeds and privileges
packages/domain/research/
  types.ts            refusal codes, row shapes, the fillable-field set
  sourcePolicy.ts     which URLs and which addresses research may reach
  pageText.ts         fetched bytes to bounded, whole blocks
  businessEmail.ts    the one on-domain address a firm publishes
  facts.ts            the closed fact set and the quote-provenance rule
  zone.ts             the coordinate time-zone table (pure)
  firmZone.ts         recording a coordinate and deciding the firm's zone
  providers.ts        the three provider interfaces
  testing/fixtures.ts the only implementations of them in this repository
  configuration.ts    settings, approved providers, the cost/failure ledger
  routeEligibility.ts the versioned thresholds, with history
  ceilings.ts         the clearance every provider call needs
  suppression.ts      whether a firm may be researched at all
  suggestions.ts      record, list, review; the automatic-fill rule
  duplicates.ts       duplicate candidates, as suggestions only
  discovery.ts        one page of one query
  enrichment.ts       one firm at one revision
  jobs.ts             the two Appendix C keys, and the enqueue gate
apps/worker/src/handlers/research.ts   the two handlers
apps/api/src/routes/research.ts        the seven paths
```

## The five rules a reader should carry

### 1. Invariant 8 is structural, not careful

> Research never initiates outreach. Research may create evidence and eligible CRM
> data, but enrollment and first contact are deliberate salesperson actions.

Three things make that true rather than intended, and
`packages/domain/test/research/invariant8.test.ts` asserts all three:

* **no import** under `research/` reaches a module whose name contains `sequence`,
  `enroll`, `outbound`, `gmail`, `mailbox`, `dial` or `send`, and no statement names an
  outreach table;
* **a census** of every table a contact or a send could live in is identical before and
  after the whole research surface runs, with the most permissive configuration a
  person could set;
* **the only job kinds** that appear in `jobs` are `research.page` and `research.firm`.

The schema is the fourth: there is no column in migration 0005 that could hold an
enrollment, a fence, a ticket or an opportunity.

### 2. A provider is an interface, and there are no implementations

`providers.ts` declares three seams — discovery, page fetch, fact extraction — and
nothing in `packages/domain/research/**` imports `node:https`, `node:dns` or calls
`fetch`. A test walks every file in the directory and fails on either.

The only implementations in the repository are the recorded fixtures in
`testing/fixtures.ts`. They answer from written-down responses in the shape the real
adapter produces, so a content hash is stable across runs and a replay test can prove
it. The live adapters — the pinned-DNS https fetch, the Places text search, the
structured model call — are a separate reviewed change, and their obligations are
written into the interface contracts rather than left to the implementer:

* resolve the name, check **every** answer against `isPublicResearchAddress`, and pin
  the connection to the address that was checked;
* refuse a redirect to anything `researchSourcePolicy` does not call a candidate;
* bound the response in bytes before decoding, and hash the exact bytes read;
* never supply a quote — return a block reference and let `validateFactSelections` look
  the text up.

That last one is the reason a "fact" is attributable. The provider returns
`{ key, blockId }`; the quote is the block's whole text, read locally. A provider that
paraphrases, trims a qualifier or drops a negation is refused and counted.

### 3. A route becomes usable only under a published policy

Section 7.4 makes `usable` the decision of "a versioned provider/source policy". G3a
wrote the decision as a pure function over a policy object; this lane adds where the
policy comes from: `research_route_policies`, insert-only, one row per version with its
own `effective_from`.

| | |
|---|---|
| Publish a threshold | `POST /research/policy` — admin-only, never edits, refuses a reused name |
| The policy in force | the newest row whose `effective_from` has arrived |
| The history | every row, and a route's `eligibility_policy_version` still reads |
| Nothing in force | `policy_missing`, and migration 0004's CHECK refuses a usable route with no version anyway |

A research path cannot promote its own findings at all. Discovery records a listed
number with `source = 'research_provider'`, no technical validation and a confidence of
0.7, and `decideRouteEligibility` makes that a `candidate`. Enrichment does not even
create the route: it records a *suggestion*, and a person accepting it goes through
`addEmailRoute`, where the policy decides. The invariant-8 test publishes a policy that
trusts the research provider and waives validation, and still no route is promoted.

### 4. Every provider call is cleared, priced and accounted

```
claimResearchClearance   →  research disabled? provider approved? enabled?
                            provider's own daily ceiling? the day's cost ceiling?
                            then increment the workspace counter, atomically
recordProviderCall       →  calls, cost and the failure code, in one statement
```

The counter is G5's `incrementDailyCounter`, whose whole design note is the reason: a
read of "are we under the cap?" followed by a write is how the fifty-first message of a
fifty-message day gets sent. The clearance is **consumed** — a run that abandons the
work has still used the unit, because the alternative is a reservation released across
a provider call.

The cost ceiling is checked *before* the call, using the provider's reviewed per-call
price, so the spend that would break the ceiling is never made. A provider that reports
less afterwards frees budget for the next call; one that reports more could not have
been authorized.

`researchEnqueueAllowed` asks the same questions without consuming, and every enqueue
path goes through it. A workspace at its ceiling produces **no queued work** rather than
a queue of jobs that each refuse — which would burn a lease per firm and make the queue
alarm fire about work nobody wanted.

### 5. Suggestions never overwrite, and duplicates never merge

Section 7.4 permits exactly one automatic write: a **high-confidence non-contact fact**
filling an **empty** canonical field. `decideSuggestionEffect` is the only place that
decides, and `FILLABLE_CANONICAL_FIELDS` — website, address line, locality, region,
postal code — contains nothing a contact route, a note or a message could occupy. The
fill is `UPDATE … WHERE <column> IS NULL`, so a value that arrived in between is not
overwritten and the suggestion stays `proposed`. And
`research_suggestions_only_facts_apply` refuses an `applied` row of any other kind, so
a future caller that tries cannot even record it.

Accepting is a person's decision and it may overwrite; the audit event records that it
replaced a value.

A duplicate is a suggestion with the other firm's id and the signal that found it —
same website host, a shared phone route, or the same name in the same locality.
Accepting it records agreement and merges nothing. `mergeFirms` is a separate audited
command that refuses when two canonical values disagree and asks a person to choose;
automating it would automate that choice.

## Discovery, step by step

1. **Claim a clearance.** The day's ceiling and the provider's price stop the run here.
2. **Call the provider once.** One page of one query.
3. **Record the call** in the ledger, cost and failure together.
4. **Open the page row.** `(workspace, query_hash, page_hash)` is Appendix C's key, and
   it is the handler's business uniqueness. The page hash is a digest of the provider's
   exact response bytes, so a replayed job's second call returns the same page, the
   insert conflicts, and nothing is created again — `already_recorded`. That costs one
   extra provider call on a replay, which is the honest price of a provider with no
   idempotency key of its own, and it is accounted like any other call.
5. **Per candidate:** skip a domain the workspace already knows; create the firm
   unassigned; record the listing as evidence; record the coordinate; resolve the zone;
   add the listed number as a candidate route; look for duplicates.
6. **Close the page row** with what happened, including the skip counts.

## Enrichment, and the revision

Appendix C's `research-firm:{firm}:{revision}`, protected by "firm/evidence revision".
`nextFirmResearchRevision` is one more than the firm's highest recorded run, and
`research_firm_runs` is unique on `(workspace, firm, revision)`. A job materialized for
revision 3 and claimed twice finds the row it already opened.

The order matters:

```
firmIsResearchable   →  exists, active, and not suppressed
claimResearchClearance
fetch the permitted pages
per page: parse → record evidence → collect blocks and email text
one extraction call over the blocks, if a provider was given
the business email, as a suggestion
each admitted fact, as a suggestion
re-resolve the zone
duplicate candidates
```

A failed extraction is **observed**, never a reason to discard the pages and the
evidence the run already recorded. A firm with no readable website is `source_blocked`,
recorded as a refused run rather than a failure — a firm that publishes no site simply
has no pages.

### A suppressed firm is never refreshed

`firmIsResearchable` is asked before the clearance and before any provider. A firm a
prospect has asked not to be contacted is not re-read, the run records
`firm_suppressed`, and the enqueue path asks the same question so the job never reaches
the queue.

`suppression.ts` reads `suppression_events` directly, because G4's authoritative
`effective_suppressions` view does not exist yet. The rule is conservative: a
firm-scoped event from one of the four *suppressing* sources, with no direct
supersession, suppresses the firm. See
`docs/decisions/g10-suppression-read.md`.

## The firm's time zone comes from its coordinate

Section 9.2 resolves a firm's zone "from location or postal data under a versioned
source rule". G3a filled the seam with a three-digit postal table that answers for
Texas and Florida and refuses the other thirteen multi-zone states, and asked whether a
coordinate should supersede it. It should, and `zone.ts` is the better source:

| | G3a's postal table | this coordinate table |
|---|---|---|
| Multi-zone states answered | 2 | 11 |
| Refuses the seam | by absence | by an explicit per-state margin |
| Refuses an enclave | by absence | by a `null` side, named and explained |
| Arizona | refused | refused (the Navajo Nation is a polygon) |

`RESEARCH_FIRM_ZONE_SOURCES` is `[coordinates, postal]`. `FIRM_ZONE_SOURCES` in
`@fss/domain/crm` keeps the postal source alone, which is correct rather than an
oversight: a firm typed in by hand has an address and no coordinate. See
`docs/decisions/g10-coordinate-zone-source.md`.

## What is deliberately not here

* **A scheduler source.** Every other kind in Appendix C becomes due on its own;
  research does not. A sweep is a decision to spend money on a territory and an
  enrichment is a decision to re-read somebody's website. Both are enqueued by an admin
  command, or by the discovery run that just created the firm.
  `docs/decisions/g10-no-scheduler-source.md`.
* **Live provider adapters.** A separate reviewed change. The worker registers a
  handler only for the provider kinds it was given, so today's image claims neither
  research kind and the jobs wait rather than failing.
* **Creating contacts and routes from enrichment.** Suggestions instead.
  `docs/decisions/g10-enrichment-suggests-routes.md`.
* **Evidence retention deletion.** The provider's terms are recorded and
  `evidence_items.retention_expires_at` is written; the sweep that acts on it is lane
  G14's retention batch.
* **LinkedIn.** `researchSourcePolicy` calls it `manual_only`, and nothing reads it.

## Shipping it

`Dockerfile.api`, `Dockerfile.worker` and their `.dockerignore` files are allow-lists of
directories, not deny-lists: a package a process imports but nobody listed is simply
absent from the image, and the container dies at start-up with `ERR_MODULE_NOT_FOUND`.
`packages/domain/research` is listed in all four, and so is `packages/domain/crm`,
because research reaches into it. Both images also `rm -rf
packages/domain/research/testing`, since `**/test/**` does not match a directory called
`testing` and the recorded provider fixtures are test data.

The last block of `test/research/rules.test.ts` checks this without Docker: it reads
which `@fss/domain/*` subpaths each app's own source imports, adds the siblings this
package reaches, and asserts every one of them appears in that image's `COPY` lines and
allow-list.

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/research/rules.test.ts       # the pure rules
npm run test --workspace packages/domain -- test/research/commands.test.ts    # the database
npm run test --workspace packages/domain -- test/research/invariant8.test.ts  # invariant 8
npm run test --workspace apps/worker -- test/researchHandlers.test.ts         # G 2
npm run test --workspace apps/api -- test/research.test.ts                    # the routes
```

`packages/domain/test/db/support/researchCases.ts` has a failing insert for every
constraint migration 0005 adds; the coverage test at the bottom of
`test/db/constraints.test.ts` fails the build if a future migration adds one without a
case.
