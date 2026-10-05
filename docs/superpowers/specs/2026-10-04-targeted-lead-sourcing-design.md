# Targeted lead sourcing for Callie

Status: proposed design for review; no product changes or sending enabled.
Baseline: origin/main f967e636, identical product tree to the inspected 12c274ba checkout. The primary checkout's local main is an older September branch; it is not the baseline for this work.

## Outcome and agreed scope

Give David a ranked queue of firms with a specific, defensible reason to discuss maintenance automation. Prioritize small teams without dedicated maintenance support. DFW Home's two-person team managing 200 doors is a hypothesis-generating example, not proof that cold lookalikes convert: that customer came through a family connection.

Cover Texas and the Providence/Boston areas. Prioritize single-family/scattered-site managers; include other residential managers with strong evidence of need. Door count is context, not a cutoff. Existing coordinators or software do not disqualify a firm, but existing software alone is not a positive signal. Outreach must accurately distinguish AppFolio's currently working integration from proposed support for other systems.

Automatically admit well-supported matches; send uncertain matches to review. Show all admitted leads, ranked and paginated, without a daily display cap. Callbacks and commitments retain priority. Existing spending limits still constrain research. Use public sources and eligible existing credits; buy no subscriptions. Sending remains paused, and sourcing does not grant contact permission or change calling-state settings.

## Approach comparison

1. **Recommended: researched seed batches plus scheduled website monitoring.** Use research performed here or supplied by David to discover candidates, then let the existing worker refresh their first-party sources. Reuses the research stack and requires no paid search subscription. Initial discovery is batch-assisted, not a continuously searching autonomous agent.
2. **Fully automated web/social discovery.** Broader reach, but requires a production search/data source and dependable social access. Chat browsing tools are not an API that the deployed worker can call. Defer until access and actual cost are established.
3. **Large static directory import.** Easy to produce volume but weak on need and timing. Directory reuse restrictions also vary. Do not make bulk directory harvesting a dependency.

## Signals: evidence before scores

| Signal | Evidence required | Treatment |
| --- | --- | --- |
| Explicit request for maintenance help | Identified business decision-maker or official firm seeking help with intake, coordination, vendor follow-up or after-hours coverage | Highest priority when current; distinguish a buyer from a vendor advertising a solution |
| Owner or small team directly covering coordination | Explicit statement describing who handles calls, work orders or vendor chasing | Strong fit; do not infer missing support from a short team page |
| Hiring for matching coordination duties | Employer-owned or employer-linked job description naming relevant duties | Strong investigation lead, particularly evening coverage; not proof the firm lacks support |
| Growth plus documented capacity pressure | Dated portfolio change together with explicit workload or staffing evidence | Useful combined trigger; growth alone stays weak |
| Existing tool with an unmet need | Identified firm's explicit complaint or request concerning its current workflow/tool | Eligible secondary cohort; competitor installation alone gives no boost |
| Tenant instructions, generic 24/7 service, ratings | Published workflow facts or complaints without buyer confirmation | Context/questions only; insufficient alone for automatic admission |

No inference of doors from live rental listings, understaffing from omitted staff, or buying intent from likes. Deduplicate copied postings: five copies of one job are one signal. Public reviews can motivate a question but cannot establish the cause of a service failure. Anonymous forum posts can inform hypotheses, not automatically identify a firm.

### Concrete source checks

- [J&W's maintenance page](https://jandwproperty.com/residents/maintenance-request/) exposes separate general and after-hours routing. It supports a question about triage; it does not establish understaffing or dissatisfaction.
- [Stonelink's technician posting](https://www.stonelinkpm.com/maintenance-technician/) describes physical repair work and existing maintenance contact centers. A keyword-only classifier would mistake this for a coordination opportunity.
- [Green Ocean's job listing](https://greenoceanpropertymanagement.com/job-openings/) appeared in search with evening maintenance coordination roles. Direct retrieval timed out in this check: treat it as an unverified candidate until the employer page can be read. Search crawl time is not the job's publication date.
- [NARPM's national directory](https://www.narpm.org/find/property-managers/) states restrictions on copying/redistribution. Do not presume every public directory permits bulk import; verify each source's reuse conditions before making it an adapter.

## Existing code and the smallest useful extension

The inspected research implementation lives under `packages/domain/research`, with its contract in `packages/contracts/src/research.ts` and design in `docs/greenfield/research.md`. It enriches existing firms and retains sourced evidence; it does not implement general discovery. Its current call-first rule uses fit and reachability rather than requiring demonstrated pain or timing. Published maintenance workflow can count as problem evidence, which is too broad for this new admission decision.

Retain the existing worker, Postgres, budget accounting, bounded fetcher and source protections. Extend page discovery to include tenant, resident, maintenance, emergency and FAQ links within its page budget. Prefer relevant discovered links over guessing many paths. Reuse current import/matching behavior and CRM identities rather than build a second contact database.

Add four narrow capabilities:

1. **Candidate intake:** accept discovered firm URL, location, source URL, discovery time and hypothesis. Research batches use a preview that reports duplicates, review cases and eligible candidates before durable intake. This stores candidates without starting outreach.
2. **Evidence extraction:** return bounded structured facts with source references and supporting text. Keep observed facts, inferred hypotheses and unknowns separate. Page content is untrusted data, never instructions for tools or workflow.
3. **Qualification/admission:** apply deterministic eligibility rules to verified evidence. Models propose facts; they cannot invent permissions, lift stops or create deals.
4. **Refresh and learning:** refresh eligible sources, retain changed evidence and associate subsequent call feedback with the originating hypothesis.

## Admission and ranking

Automatic admission requires a resolved firm identity, supported geography and residential-management fit, a published business contact route, and either an explicit relevant help request or an explicit matching operational burden. A live coordinator job is an investigation signal and initially goes to review unless it also states a matching burden. Generic workflow pages, uncertain identities, unavailable evidence and inferred lack of support go to review rather than the call queue.

Check existing suppression and active-contact rules again atomically when creating the queue item. Sourcing must never bypass them. A state outside David's enabled calling list can be researched but cannot become callable until the existing state policy permits it. No contact guessing is required for admission to review.

Rank by: existing obligations first; explicit solution seeking; directly supported operational burden; reviewed investigation leads. Within each group use evidence confidence, freshness, relevance and reachability. Do not display a fabricated conversion probability or a precise 0–100 intent score.

Each card shows: **why this firm**, **why now**, source/date, confidence, one useful opening question, and what remains unknown. A top-level badge can say Confirmed need, Evidence suggests need, or Needs verification; these labels describe evidence, not guaranteed buying intent.

## Identity, freshness and failure handling

Match through existing external IDs and normalized firm websites, with name/location corroboration. A domain shared by branches or franchises is not enough to merge distinct firms; ambiguous relationships require review. Preserve stops through the existing merge mechanism. Use a stable candidate/firm identity and idempotent admission so retries or repeated imports cannot create parallel prospecting threads.

Store discovery time, observed time, publication time when actually present, evidence URL, source type, hypothesis, confidence and qualification version. Missing publication dates stay unknown.

Initial policy defaults, not empirically proven conversion windows: recheck active candidates weekly; refresh evidence before first admission if its last observation is over seven days old. Treat help requests older than 30 days and growth events older than 90 days as needing revalidation. A live but undated job is marked undated; it cannot be advertised as newly posted. Recheck job availability before admission. A source error does not prove a signal disappeared: retain historical evidence and mark verification unavailable.

Honor existing crawl limits and source protections. Do not bypass login walls or blocked social hosts. Social evidence initially arrives as manually reviewed public links/excerpts with provenance; no authenticated social monitoring is promised. Prefer authoritative sources and only follow employer-linked job hosts under explicitly allowed fetch rules.

Research work reserves budget through existing controls, including verified provider credit coverage. Once budget is exhausted, pending research waits; admitted queue items remain visible. No new cash allowance is implied. Stop refreshing rejected firms until a reason or meaningful source change warrants another check; this avoids indefinite low-value spending.

## Validation and learning

Start with 15–20 candidates per available strong hypothesis and a comparably sized fit-only comparison group, matched approximately by geography and size where known. Do not manufacture strong-signal leads to fill quotas. David reviews the comparison group before any queue admission. Record differences in contactability and warm introductions; otherwise they confound the comparison.

Measure evidence accuracy, qualification corrections, confirmed pain per answered call, qualified meetings held, customers and research cost per useful lead. Log no answer separately from rejection. Initial samples are exploratory, not proof of superiority. Use brief corrections such as already covered, wrong firm, real pain, and not relevant; do not add a long compulsory form after every call.

Acceptance checks cover: resident-page discovery; physical technician versus coordinator roles; stale/undated sources; duplicated job posts; anonymous authors; same-name firms; franchise ambiguity; crawl failure; budget exhaustion; stopped contacts; repeated admission; and atomic enforcement of one active contact per firm. Run one real sourced batch through preview, persistence, queue presentation and evidence review. Passing fixtures is not validation of lead quality.

## Delivery boundaries

First ship candidate intake, evidence presentation and review using a small real batch. Then add deterministic admission and bounded scheduled refresh, followed by feedback reporting. These reuse the existing CRM rather than introduce a separate sourcing service, vector database or autonomous browser fleet.

Not included: paid databases, automatic whole-web search, social account automation, new outbound permissions, automatic deals, or an email-volume increase. Those are independent workstreams. The ten-call suggestion trial remains separate from testing sourcing hypotheses.

## Research basis and limits

[Gojiberry's Mindflow case](https://gojiberry.ai/case-study-mindflow) describes category-specific pain language and engagement signals; [Wispra](https://gojiberry.ai/case-study-wispra) illustrates participation in relevant topic conversations. [Clay's Intercom case](https://www.clay.com/customers/intercom) illustrates deriving criteria from existing customers and operational context. These are vendor-published case studies, not controlled evidence that the same signals predict Callie purchases. Their useful lesson is to test a specific problem hypothesis against customer outcomes, not copy reported reply rates into a forecast.
