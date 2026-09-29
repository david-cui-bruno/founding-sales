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

The firm's own website — home, about, services, team, contact, careers and jobs pages
on the same host — the firm's own public job page when it is on that host, links David
adds by hand, and the CSV import or the Add-firm form as the discovery input.

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
* **Re-check every redirect.** A redirect is a new URL and gets the whole rule again:
  the policy, a fresh resolution, a fresh pin. Three hops at most. Otherwise the firm's
  own server decides where this worker connects.
* **Bound the response in bytes before decoding, and hash the exact bytes read.** The
  content hash is the evidence item's identity, so it has to be over what was actually
  read and nothing else. A page over the cap is dropped whole; a half page is text
  nobody published.
* **Never let a provider supply a quote.** An extraction returns
  `{ key, sourceReference, blockId }` and no text field at all, and the quote is looked
  up locally. A model that paraphrases, trims a qualifier or drops a negation is
  refused rather than believed.

`robots.txt` is fetched first, the same pinned way, once per host per run, and honoured
for `*` and for `CallieResearch`. A disallowed path is skipped. A host that will not
serve the file has disallowed nothing: the absence is the permissive answer in the
standard, and treating a timeout as a prohibition would make a slow host unreadable for
ever.

## The caps, and the price table

Three ceilings, all in whole cents, all checked in `claimResearchClearance` before any
provider is reached:

| Setting | Default | What it bounds |
|---|---|---|
| `enabled` | `true` | Whether anything runs at all |
| `daily_firm_ceiling` | 50 | Runs per workspace business date |
| `daily_cost_ceiling_cents` | 50 | Today's spend, across every provider |
| `monthly_cost_ceiling_cents` | 1000 | Month-to-date spend, in the workspace's zone |
| `max_pages_per_firm` | 4 | How far down the path allow-list a run reads |
| `max_page_bytes` | 1 000 000 | The fetch's byte cap |
| `model_name` | `claude-haiku-4-5` | The one model with a reviewed price row |

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

At the defaults the worst case is **2 cents a run**: four pages at the parse cap of
12 000 characters each, about 13 500 input tokens, plus 600 bounded output tokens. So
50 cents a day is 25 runs and $10 a month is 500. The bound is the parse cap and not
`max_page_bytes`: a page is fetched as bytes and then parsed, and `parsePageText` never
offers the extractor more than 12 000 characters however large the page was. Using the
byte cap would give a worst case of about a dollar a run, which the default daily
ceiling would refuse for ever.

## The four judgments

| Judgment | `yes` when | `no` when | otherwise |
|---|---|---|---|
| `fit` | `target_fit` | `not_target` (which beats `target_fit`) | `unknown` |
| `problem_evidence` | `maintenance_workflow` or `hiring_maintenance` | never | `unknown` |
| `timing` | `recent_change` or `hiring_maintenance` | never | `unknown` |
| `reachability` | a usable or candidate phone route, or `phone_listed`, or `named_role` | an active firm-wide suppression | `unknown` |

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
