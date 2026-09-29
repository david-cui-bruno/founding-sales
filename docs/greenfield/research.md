# Research: firm facts with sources, four judgments, a call brief

Design record `.context/DECISION-20260928-crm-design.md` ("Research"), plan
`.context/PLAN-20260928-crm-v1.md` §3 "R", and David's answers 5 and 8: read-only
lookups of the firm's own site, a budget of $20–30 a month with calls ahead of
everything else.

The old research feature was deleted on 26 September 2026 (commit `59b3e1bb`) and
migration 0019 dropped its eight tables. It had no live adapter, no scheduler source
and no caller on the Mac. This is the smaller thing that replaces it: read the firm's
own website, record what it published as evidence, keep four judgments apart, and
price every model call in cents before it is made.

## The rules, in the design record's words

* **Every fact shows its source, its retrieval date and its uncertainty.** A fact row
  points at the `evidence_items` row that recorded the page; the quote is the whole
  text of a block from that page; `retrieved_at` is when it was read.
* **Four judgments, kept separate**: fit, evidence of a relevant problem, timing,
  ability to reach someone. They fail separately, so they are stored separately.
* **No judgment claims budget or intent.** "A portal link can support a software
  inference; a maintenance job posting can suggest an opportunity for discussion.
  Neither proves budget or buying intent." There is no column, no key and no judgment
  for either, deliberately.
* **The brief distinguishes the firm's own words from an AI interpretation.** A quote
  carries its source; the two questions and the opening line are written by a model,
  stored under `generated: true`, and labelled "AI suggestion" on the card.
* **Research never initiates outreach.** It creates no contact, no route and no
  opportunity, and it never touches a suppressed or merged firm.

### Sources, in v1

The firm's own website — home, about, services, careers, jobs, team and contact pages
on the same host — the firm's own public job page when it is on that host, links David
adds by hand, and the CSV import or the Add-firm form as the discovery input.

The path order above is the order they are read in, and it is load-bearing, because
`max_pages_per_firm` is a prefix of the list and its default is four. Careers comes
before team and contact because a maintenance job posting is the only evidence
`hiring_maintenance` has, and that one key feeds two of the four judgments — problem
evidence and timing. With careers fifth, the default settings would never fetch it and
two judgments would read `unknown` on every firm for a reason nobody could see.

**A firm's own navigation beats that list.** Real sites call these pages `/about-us`,
`/our-team`, `/contact-us`, `/services/` and `/join-our-team`, and on one of those an
exact-path allow-list reads the homepage and nothing else. So after the homepage is
read, its own anchors are scanned — a small lexical `<a href>` pass in `pageText.ts`,
no HTML dependency — the same-site ones are normalised (absolute, https, no query, no
fragment, no trailing slash), at most twenty are kept, and the ones whose path matches
`about|service|team|staff|contact|career|job|hiring` are queued behind the fixed list.
Each one still goes through the permission rule, a fresh resolution with every address
checked, that host's robots and the byte cap, and they are fetched only while the
`max_pages_per_firm` budget has room — so in practice they spend the budget a `404` on
a guessed path freed. A link off the firm's site, or to a blocked host, is not queued at
all, and `mailto:`, `tel:` and `javascript:` hrefs are not URLs research reads.

Deliberately **not** here: LinkedIn and every social host, any paid enrichment
provider, any directory or job aggregator, and any Places query. Places is deferred and
David-held. A listing is somebody else's database about the firm, so a quote from one
could not be shown as the firm's own words even if the terms allowed reading it — which
is the same sentence that makes the firm's own careers page the only job source there
is.

## The tables (migration 0023)

| Table | What it holds |
|---|---|
| `research_settings` | One row per workspace. **An absent row is the defaults**, not "off". |
| `research_runs` | One run of one firm at one revision. Unique on `(workspace, firm, revision)`. |
| `firm_facts` | One admitted selection: a key, the evidence item, the block id, and the block's whole text as the quote. |
| `firm_judgments` | The **current** judgment, keyed by the firm and replaced by each completed run. |
| `firm_links` | The https pages a person added by hand. `added_by_user_id` is NOT NULL. |
| `provider_ledger` | Calls, failures and cents per provider per workspace business date. Generic: lanes C and D reuse it. |

Migration 0023 is additive and **refuses on nothing**, so it has no
`fss admin schema-preflight` command and the release skips step 3. It also carries one
`CREATE OR REPLACE` of `today_algorithm_version()`, because lane 4's order changed.

`provider_ledger` is not `research_provider_ledger` on purpose. Telephony (lane C) and
calendar (lane D) each need "what did this provider cost today, and what failed", and
three tables with the same five columns would be three places to get the business date
wrong. The date is derived in the workspace's zone and stored beside the zone that
produced it, exactly as `daily_counters` does.

## One run, step by step

1. **Is the firm researchable** — active, not merged, no active firm-wide
   do-not-contact (`firmState.ts`). Asked *before* any clearance, so a refusal here
   does not spend a unit of the day's budget. A refusal is still recorded as a run row:
   "research is disabled" and "research has never looked at this firm" are different
   facts and the runs list is where a person finds out which.
2. **Open the run** (`runs.ts`). The insert *is* the idempotency check: a second claim
   of the same job finds `research_runs_one_per_revision` refuses it and reports
   `already_recorded` having fetched nothing.
3. **Claim the clearance** (`ceilings.ts`). Consumed, not reserved.
4. **Build the URL list** from the firm's website and its links (`sourcePolicy.ts`),
   and refuse `no_sources` when there is nothing to read.
5. **Fetch** through the port. Each page is parsed into bounded blocks
   (`pageText.ts`) and recorded as one `evidence_items` row, idempotent on the content
   hash — so a page unchanged since the last run is recorded once.
6. **Extract**, when the port is there: the blocks by id, the key dictionary, and a
   schema-constrained JSON answer of selections and two generated lines. Every
   selection goes through `validateFactSelections` before it becomes a `firm_facts`
   row.
7. **Judge** (`judgments.ts`), upsert `firm_judgments`, write the generated parts to
   `research_runs.brief`, record the ledger row, and complete.

Without an extraction port the run records the evidence, sets fit, problem evidence
and timing to `unknown`, derives reachability from the firm's routes and its
suppression, and completes. That is a smaller answer, not a failure, and the evidence
is what a later run's facts will point at.

## The ports, and what they owe

Two seams, both interfaces in `packages/domain/research/providers.ts`, with the live
adapters in `apps/worker/src/research/`. Nothing under `packages/domain/research`
imports `node:https`, `node:http`, `node:dns`, `undici` or `fetch`, and
`test/research/rules.test.ts` reads every file in the directory and fails on one that
does — which is what makes "no live provider call in the domain" checkable rather than
claimed.

Four obligations, each one learned the hard way by the build before this one:

* **Resolve the name, check every answer, pin the connection.** A firm's DNS answer is
  attacker-controlled input. `https.request('https://host/')` resolves inside the
  socket, so a check made before the request would be checking a different lookup from
  the one that connects. Every address must pass `isPublicResearchAddress` — *every*
  one, because a name that also answers with `169.254.169.254` is a name that will one
  day answer with only that — and the socket connects to the checked address with
  `servername` and `Host` carrying the name.
* **Re-check every redirect.** A redirect is a new URL and gets a fresh resolution and
  a fresh pin. Three hops at most. Otherwise the firm's own server decides where this
  worker connects. A **same-site** hop inherits the permission of the URL that led to
  it, whatever its path: a homepage that answers `301` to `/home`, `/en/` or
  `/index.html` is ordinary, and re-applying the exact-path allow-list there made such
  a firm yield nothing at all. A **cross-site** hop is blocked unless the target is
  itself a link a person added — the firm's own server does not get to choose a second
  site for research to read.
* **Bound the response in bytes before decoding, and hash the exact bytes read.** The
  content hash is the evidence item's identity, so it has to be over what was actually
  read and nothing else. A page over the cap is dropped whole; a half page is text
  nobody published.
* **Never let a provider supply a quote.** An extraction returns
  `{ key, sourceReference, blockId }` and no text field at all, and the quote is looked
  up locally. A model that paraphrases, trims a qualifier or drops a negation is
  refused rather than believed.

* **A URL that is fetched is stored, so it may not carry a query string.** A fetched
  URL becomes an evidence item's `source_reference` and lives as long as the quote does,
  and a query string is where a session token, a reset code, a signed URL's signature
  and an e-mail address live — none of which retention can find inside a URL. So
  `isPublicResearchUrl` refuses one: `addFirmLink` answers `link_not_permitted`
  (explicitly, because pasting from an address bar is exactly how one would arrive), and
  a redirect target with a query is skipped `url_has_query`. Fragments are dropped
  everywhere, because they never reach the server and never name a different page.

### robots.txt

Fetched first, the same pinned way, cached per host **and per checked address** for the
run, and honoured for `*` and for `CallieResearch`. Four rules:

* **A file that cannot be read completely means the host's pages are not fetched**
  (`robots_unreadable`). A `500`, a timeout, a file over 64 KB, a redirect off the site:
  none of those is permission. Only a `404` or a `410` is — the *absence* of the file is
  the permissive answer in the standard, and the absence is all that is.
* **A redirected robots is followed**, on the same site only, up to three hops, each
  with a fresh resolution and pin — and each target goes through `isPublicResearchUrl`
  like every other request. Without that last part `/robots.txt` was the one URL exempt
  from the rule, and a firm's own server could have redirected it to
  `/robots.txt?token=…`: a query string this fetcher refuses everywhere else, because a
  fetched URL is a stored URL.
* **One group applies, and it is the most specific one** (RFC 9309 §2.2.1). If the file
  names `CallieResearch` anywhere, those lines are the whole of what applies and the
  `*` group is ignored; otherwise the `*` group is. Merging them was wrong in the
  direction that matters: a site that shuts `*` out and then writes a group for us has
  told us exactly what we may read, and a union honoured the refusal and threw away the
  permission.
* **`*` and `$` mean what the standard says.** `Disallow: /*.pdf$` is a rule about
  extensions, not a literal prefix that matches nothing.
* **`Allow` is honoured, longest match wins in octets, and a tie goes to `Allow`.** A
  site that says `Disallow: /` and then `Allow: /about` has told us exactly which page it
  wants read.
* **Percent-encoding is normalised on both sides before matching** (§2.2.2): unreserved
  octets decoded, the rest upper-cased. `/~joe` and `/%7Ejoe` are one path, and a site
  that disallowed one of them meant both.

## A run is two committed steps, because the middle of it spends money

`research.firm` is a **chunked** handler (`docs/greenfield/jobs.md`, "Chunked bulk
work"), and the chunk boundary is where the money is:

| | What it does | What the runner does with it |
|---|---|---|
| **Chunk 1** | `beginFirmResearch`: the firm is researchable, the run row is opened, a unit of the day's count is consumed, and the worst case is **reserved** on `provider_ledger`. No provider is touched. | Commits it together with the cursor `{ runId, reservedCents, step: 'reserved' }`. |
| **Chunk 2** | `finishFirmResearch`: fetch, extract, record the evidence, the facts, the judgment, the funnel facts; turn the reservation into the actual figure; close the run. | Commits it as the job's completion. |

Before the split both halves ran in the runner's single job transaction, and that was
the worst bug this lane had. A lease reclaimed during the extraction — or any database
error after the paid call — rolled back the run row, the ledger row **and the consumed
counter**, while the money stayed spent at the provider. The retry then spent it again
against a budget that had never heard of the first attempt: three attempts, three
invoices, one visible cent.

Now a rollback of chunk 2 leaves chunk 1 standing. The second claim resumes from the
cursor, finds its run row and its reservation, and consumes no second unit. The month is
over-counted by a few cents until the run settles, which is the direction in which
nothing can be lost.

**`outcome = 'running'` is therefore a normal state**, not a crash — and a row still
`running` after thirty minutes is one. The sweep's first act is `finaliseAbandonedRuns`:
those rows become `failed` with `refusal_code = 'lease_lost'` and **keep their
reservation as the recorded cost**, because the last thing that worker did before
disappearing may well have been to make the call, and releasing the cents would be
claiming it did not. `run_in_progress` refuses the firm a new revision inside the same
window, so the firm becomes researchable again in the same breath.

### The ledger reserves before it spends

`cost_cents` is what was invoiced; `reserved_cents` is what has been authorized and not
yet invoiced. `readSpend` counts **both**, so a run in flight is already spent as far as
the next clearance is concerned — anything else lets two runs started in the same minute
each be cleared against the same remaining cents.

A reservation is settled three ways: released whole when the run asked the provider
nothing (no sources, no model key), turned into the invoice when a figure comes back, or
**recorded as the cost** when no figure does. That last one is `cost_estimated` on the
run row, and it covers a thrown transport, a response with no `usage`, and a lost lease.
Zero is the one answer that is certainly wrong about a call that may have been billed.

### When a provider fails

A provider failure — reported or thrown — becomes a **committed `failed` run** and the
job **completes**. It is never a throw, for the reason above.

The retry is the sweep's: a new revision with a new clearance, one a business day, three
consecutive failures at most (`MAX_CONSECUTIVE_FAILED_RUNS`), and that gate covers every
branch of the sweep's "due again" test rather than one of them. After three the firm is
left alone and the firm page shows "research failed, N tries" rather than a brief that is
quietly a week out of date.

**"The next business day" is the next local calendar date, weekends included.** A firm
whose site failed on a Friday is retried on the Saturday. That is deliberate: research
sends nothing and contacts nobody, so a Saturday run costs a fraction of a cent and no
goodwill, and a five-day-week retry ladder would be a calendar the rest of this system
does not have.

A database error is the one thing that still aborts, and there it is right: the
accounting is written in the same transaction as the work, so a transaction that cannot
commit has no accounting to lose — and chunk 1's, which is the part that matters, has
already committed.

## The caps, and the price table

Three ceilings, all in whole cents, all checked in `claimResearchClearance` before any
provider is reached:

| Setting | Default | What it bounds |
|---|---|---|
| `enabled` | `true` | Whether anything runs at all |
| `daily_firm_ceiling` | 50 | Runs per workspace business date |
| `daily_cost_ceiling_cents` | 50 | Today's spend, across every provider |
| `monthly_cost_ceiling_cents` | 1000 | Month-to-date spend, in the workspace's zone |
| `max_pages_per_firm` | 4 | **Total** pages one run may fetch |
| `max_page_bytes` | 1 000 000 | The fetch's byte cap |
| `model_name` | `claude-haiku-4-5` | The one model with a reviewed price row |

`research_runs.extraction` records why the model was or was not used — `used`,
`unconfigured`, `no_pages`, `failed` — because a null `model_name` could not say, and the
difference decides whether the sweep ever comes back. Only `unconfigured` is re-selected
once a key exists: a run that found no readable pages will find none tomorrow either, and
re-selecting it was a unit of the day's budget spent on the same nothing every morning
for ever.

The count ceiling is `daily_counters` through `incrementDailyCounter`, which is one
statement, because "a read of 'are we under the cap?' followed by a write is the
classic way to send the fifty-first message of a fifty-message day". A clearance is
**consumed**: a caller that abandons the work has still used the unit. The alternative
— a reservation released on failure — is a distributed transaction with a provider, and
losing a unit of a daily count is the cheaper error.

The two money checks use a **worst case**, because the invoice does not exist yet. A
run that turns out cheaper frees budget for the next; a run that could turn out dearer
could not have been authorized at all.

**Prices, read on 28 September 2026** (`pricing.ts`). Claude Haiku 4.5: 100 cents per
million input tokens, 500 cents per million output. A model with no row **cannot run**
— `centsOf` throws rather than returning zero, because a zero would spend a month's
budget in an afternoon. Adding a model is three edits (the CHECK, the price table, the
contract's enum) and that friction is the feature.

Cached input tokens are priced too — a cache write at 1.25× input, a cache read at
0.1× — even though the extraction sends no `cache_control`. A category nobody prices is
a category the ceilings cannot see, and a cache *write* is dearer than an ordinary
token. Caching was removed from the request rather than kept: every run's message is a
different firm's pages, so there is no prefix worth reusing and it bought a surcharge on
the one small part that repeats.

At the defaults the worst case is **3 cents a run**, and three things make it a bound
rather than an estimate:

* **`max_pages_per_firm` is the total page count**, not the count of the firm's own
  pages. `researchUrlsForFirm` enforces the same number — added links first, then the
  allow-listed paths, then homepage-discovered links — and the adapter enforces it
  again. When added links were appended *on top of* this figure, a firm with six links
  sent ten pages priced as four.
* **Per page it is the parse cap, not `max_page_bytes`.** A page is fetched as bytes and
  then parsed, and `parsePageText` never offers the extractor more than 12 000
  characters however large the page was. Using the byte cap would give a worst case of
  about a dollar a run, which the default daily ceiling would refuse for ever.
* **Characters per token is 2.5 and the prompt overhead is 2 000 tokens**, both chosen
  high. Four characters a token is the figure for prose; what the extractor is sent is
  nav labels, addresses, telephone numbers and JSON punctuation, which tokenize far
  worse. A bound that is too small is a ceiling that authorized a call it had not
  priced, and the headroom costs a fraction of a cent a run.

At the defaults that is **3 cents a run** (24 866 input tokens), so 50 cents a day is 16
runs and $10 a month is 333; at the maximum of eight pages it is 6 cents. The ledger
always records the **actual** figure, never truncated to the bound: a ledger that clipped
its own numbers would hide exactly the overrun the bound exists to prevent. One test
builds a real request at the maximum — four pages of a hundred full blocks, every marker,
a 500-character source URL — and measures it against the bound, because a bound that was
never compared with a request is a number in a comment.

## At a merge

Four tables, three different answers, because they mean three different things
(`crm/merges.ts`):

* **`firm_judgments`** is one current opinion per firm, so there is nothing to merge.
  If the target has one, the source's is deleted; if it has none, the source's is moved
  with `likely_contact_id` cleared first — the contact it names has not moved yet, and
  the composite key refuses a row naming a contact at another firm. Either way a fresh
  run is enqueued for the target, so its judgment is rebuilt from its own pages.
* **`firm_links`** are decisions somebody made about a firm that is about to be one
  firm, so both sides' links are copied onto the target (`firm_links_one_per_url` makes
  the same URL on both one row) and the source's are dropped.
* **`research_runs` and `firm_facts` stay on the merged source**, as `crm_domain_events`
  do. They record what was read, at which URL, on which day; re-attributing them would
  be inventing provenance.

All of it happens **before the contacts move**. `firm_judgments.likely_contact_id`
carries `(workspace_id, contact_id, firm_id)` with `ON UPDATE CASCADE`, so moving a
contact rewrites the source judgment's `firm_id` — and when both firms were researched
that lands on the target's primary key and fails a merge for a reason no reader of the
merge function could see.

## The four judgments

| Judgment | `yes` when | `no` when | otherwise | third-party facts |
|---|---|---|---|---|
| `fit` | `target_fit` | `not_target` (which beats `target_fit`) | `unknown` | ignored |
| `problem_evidence` | `maintenance_workflow` or `hiring_maintenance` | never | `unknown` | counted |
| `timing` | `recent_change` or `hiring_maintenance` | never | `unknown` | counted |
| `reachability` | a usable or candidate phone route, or `phone_listed`, or `named_role` | an active firm-wide suppression | `unknown` | ignored |

**A page on somebody else's host is not the firm speaking.** Every fact carries
`first_party`, derived from the **final URL's** relationship to the firm's own site and
not from how the URL came to be permitted — an added link to a page on the firm's own
host is the firm's own words, and deriving the flag from the permission marked it as
somebody else's because `added_link` is decided before the host check. True for the
firm's own site and for a page its own homepage linked to; false for a link on another
host. `fit` is a statement about what the
firm *is* and `reachability` that the *firm* publishes a way to reach a person, so both
use first-party facts only — a trade article calling a brokerage a property manager
must not become `fit: 'yes'`. Problem evidence and timing are claims about the world and
count either source. On the brief a third-party quote is rendered with its host
("per news.test").

**Three keys store no quote.** `named_role`, `phone_listed` and `role` are selected
*because* a block names a person or publishes a number, and a contact-scoped deletion
does not touch a firm's rows — so a quote here would outlive the person it names, in a
table nobody would think to search. The evidence id and the block id stay, so the
judgment can still cite the page; the sentence is not copied.
`firm_facts_person_keys_have_no_quote` is that rule as an equality, so the key set and
the schema cannot drift apart.

`call_first = fit === 'yes' && reachability !== 'no'`, and
`firm_judgments_call_first_consistent` holds the row to exactly that expression.

**`unknown` is never `no`.** Silence is not a denial. A firm whose site says nothing
about maintenance gets `unknown`, and the only two `no`s reachable are the firm's own
site saying it is not that kind of firm, and a suppression — which is a fact about us
rather than about them.

**Nothing infers budget or intent.** There is no fifth judgment, no score and no field
that could hold one. A reader who wants either has to make the call themselves, which
is the honest arrangement.

`reasons` is one short sentence per judgment naming the `firm_facts` ids it rests on,
so "why does this say yes" is answerable without re-deriving it.

## The call brief

Assembled at read time from `firm_facts`, `firm_judgments`, `research_runs.brief` and
`contacts` — only the generated parts are stored, so a brief can never be staler than
the facts behind it.

```
whyFit        up to three quotes, each with its source and retrieval date
whatChanged   up to two quotes
likelyPerson  the contact whose title a role fact names, or null
questions     two, written by a model            ← generated
opening       one line, written by a model       ← generated
generated     true whenever either of those two is present
judgments     the four, judgedAt, revision
sources       every distinct source behind the quotes
```

`generated` is the claim the desktop turns into the words "AI suggestion". A brief with
no generated part is still a brief.

## The surface

| Path | What it is |
|---|---|
| `POST /research/firm` | The read: brief, facts, judgments, the last five runs, the links, the spend. Assignee or admin; a colleague gets the firm page's `not_found`. |
| `POST /research/firm/run` | A command. `ceiling_reached` when the clearance would refuse now. |
| `POST /research/firm/links/add` | A command. https only; adds the link and enqueues a run. |
| `POST /research/settings` | Admin only, including the read: the read *is* the workspace's budget. |

The Today card gains `brief` (optional, omitted from card version 1), and lane 4 puts
the `call_first` firms in front. The firm page's `crmSurface.ts` contract is
**untouched** — it is a `z.strictObject` behind `pageVersion`, and the desktop's
Research section reads `/research/firm` instead.

### Every refusal code

`invalid_input`, `research_disabled`, `daily_firm_ceiling`, `daily_cost_ceiling`,
`monthly_cost_ceiling`, `ceiling_reached` (the route's summary of the three above),
`firm_unknown`, `firm_merged`, `firm_suppressed`, `not_assigned`, `admin_only`,
`run_in_progress`, `no_sources`, `provider_failure`, `link_not_permitted`,
`model_unpriced`.

## The sweep

`research.sweep`, one per workspace per business date. Research is otherwise driven by
events — a firm is created, a person clicks, a link is added — and events do not cover
the case that matters most: a firm imported on a day the ceiling was already spent. An
import of two hundred rows enqueues two hundred runs that the ceilings pace across
days, and the sweep is what finishes the ones a day's budget did not reach.

It selects firms that are active, not merged, not suppressed, have **no closed
opportunity** — a Won firm is a client and a Lost one has said no; re-researching either
is spending money to put somebody back on a morning list they have already left — and
were never researched or last completed more than ninety days ago. Oldest first.

## The funnel

Two facts, both inside the run's transaction (`docs/greenfield/funnel.md`):

* `firm.researched`, keyed `{firm}:{revision}`, with
  `{ revision, fit, reachability }` — the run's identity, so a replay produces one
  fact rather than a unique violation that would abort the transaction;
* `firm.queued_for_call`, keyed by the **firm alone**, recorded only when `call_first`
  becomes true for a firm whose previous judgment was not. A funnel counts the firms
  that reached the call-first queue, not how many times research agreed with itself, so
  the key is the firm and the later runs are duplicates the recorder drops.

A refused or failed run records neither: nothing reached the queue and nothing was
learned.

## What is deliberately not here

* **Places discovery.** Deferred; David-held.
* **Any paid enrichment provider.** The only paid call is the extraction, and it is the
  key the reply classifier already has.
* **Contact and route creation.** Research suggests a likely person by pointing at a
  contact that already exists. It creates none, and it promotes no route.
* **LinkedIn, social hosts and job aggregators.** Blocked by host, on any path, however
  the URL was reached — including a link a person tries to add.
