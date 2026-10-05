# Callie: five-part sales roadmap

Status: consolidated design draft, 5 October 2026. This combines David's interview decisions with proposed engineering defaults. It is not an implementation or activation report. Plan all five parts before executing them. The two external delivery dependencies below remain unresolved; do not describe the whole roadmap as ready to deploy.

## The result

Give David a steady, useful queue of property managers to contact, with a defensible reason to call, coordinated follow-up, and evidence about what actually produces qualified demos. Then turn approved ideas and images into scheduled social posts.

David's choices: stronger leads into calls first, autonomous email next, social after that. Use AWS/GCP credits and existing free allowances; preserve the $25 additional monthly cash ceiling. No spending on X. Keep React, shadcn and Tailwind. Keep Today focused on action and put metrics elsewhere. No new paid database, mobile app, video pipeline or infrastructure rewrite.

A qualified demo is **held**, includes someone involved in buying, establishes a real maintenance-workflow need, and includes openness to paying. Booked, held and qualified are separate facts. There is no newly imposed door-count minimum, budget floor or buying deadline.

```mermaid
flowchart LR
  A[Scheduled discovery] --> B[Candidates and source evidence]
  B --> C{Qualification}
  C -->|Supported| D[Ranked calls or coordinated email]
  C -->|Uncertain| E[Review]
  E --> D
  D --> F[Conversations and held demos]
  F --> G[Signal results and suggested improvements]
  G -->|David approves targeting changes| A
  F --> H[Anonymized content themes]
  H --> I[Drafts plus image assets]
  I -->|David approves exact posts| J[Social scheduling]
```

## Approach and boundaries

**Recommended: extend the existing app.** Reuse Postgres, the worker/job runner, CRM identities, budget reservations, send fencing, source retrieval and desktop components. Each capability is a focused module with its own settings and clear failure states. It does not need a separate service.

A paid sales/marketing suite would reduce some integration work but conflicts with the cash constraint. A general browser-agent platform would add session, recovery and verification work throughout the product. Use a narrow background browser adapter only where it is necessary and proven, particularly for free social scheduling; do not make the whole CRM depend on it.

Preserve the existing meeting capture, booking, notes/tasks and follow-through paths. This roadmap connects their evidence and outcomes instead of rebuilding them. Deals and exceptional commercial commitments remain David's. No outreach or paid processing is enabled by a planning document.

## 1. Verify continuous discovery

**Already shipped:** schema 49, desktop 1.0.44, candidate intake, source checks, monitoring and enabled bounded discovery. **Still unverified:** the first scheduled production search, persisted results and their desktop readback. Activation preserved the exhausted daily quota; enabling a switch is not an end-to-end result.

Read back one due run through search request, quota accounting, candidate persistence and Candidates. A genuine zero-result search is a valid execution result, but does not prove useful lead yield. Verify deduplication, retried jobs and visible quota/provider failures. Do not reset usage to manufacture a successful test.

Retain the deployed one-query-per-workspace-per-UTC-day default, at most five hits, and shared 20/day and 600/month request ceilings until measured yield supports a change. These are current configuration bounds, not a forecast of daily qualified leads. Separate search availability from known-source refresh so a search quota hold does not unnecessarily stop existing-source work.

**Done when:** a real scheduled run and its accounting are checked; actual returned candidates, if any, are visible and traceable. Record useful yield separately from runtime health.

## 2. Qualify firms using useful evidence

Use the existing [targeted sourcing design](2026-10-04-targeted-lead-sourcing-design.md) and [qualification/admission plan](../plans/2026-10-05-sourcing-qualification-admission.md) as inputs. The latter predates the request to plan all five parts and does not authorize starting implementation now.

Search both for explicit maintenance problems and for plausible residential managers who never publish their problems. Cover Texas and Providence/Boston, emphasizing scattered single-family portfolios while allowing other residential firms with a strong need. DFW Home's two-person team managing 200 doors is a useful hypothesis, not evidence that every small team is overloaded.

| Evidence | Initial treatment |
|---|---|
| Identified firm explicitly requests help with intake, coordination, vendor follow-up or after-hours coverage | Highest priority if current and relevant |
| Firm explicitly describes a matching operational burden | Eligible for priority after identity/contact checks |
| Coordinator vacancy or growth | Investigate; not sufficient alone to assert pain |
| Small team, portal technology, generic 24/7 claims or tenant reviews | Context and an opening question; need unconfirmed |
| Existing maintenance support | Contrary/contextual evidence; investigate a specific remaining gap |

The bounded fetcher supplies source text to Haiku through Bedrock. Store facts with source blocks and dates; a model proposes facts, while deterministic rules decide admission. Preserve unknowns and contradictory evidence. A source failure is not proof of missing staff, discontinued support or lost interest. Reuse existing limits, reservations and credit coverage checks; no direct Anthropic/OpenAI cash fallback.

Each result shows **why this firm**, **why now or timing unknown**, an opening question, and expandable evidence. It must not promise unbuilt integrations: AppFolio works today; Buildium or other support needs an accurate current product fact.

**Done when:** a real batch is reviewed for correct identities, contacts, source meaning and freshness; strong hypotheses and fit-only comparison results are reported honestly, including insufficient examples. Fix false automatic eligibility before enabling automatic admission. Valid JSON alone is not sufficient.

## 3. Put qualified leads into the work queue

Admit supported candidates directly without CSV handoffs. Uncertain candidates remain in Candidates for a short review. Keep the existing candidate identity distinct from a CRM firm until admission succeeds; clicking Keep is not permission to start outreach.

Admission rechecks duplicate identity, geography, ownership, stops, evidence freshness and one-active-contact-per-firm atomically. A shared franchise domain is not enough to merge firms. A published business main line is usable without inventing a person's name. Replays return the same result; they cannot create another contact, deal or enrollment.

Callbacks and commitments remain ahead of new leads. Rank new firms by supported need, freshness and reachability; show all admitted leads through pagination, not an arbitrary daily display cap. Actual dialing still enforces existing state/time/budget controls.

When autonomous email is ready, use the best leads for David's calls and let other qualified, email-reachable firms start email without waiting for a call. **Qualification for a phone call is not email eligibility.** Email-only candidates can remain reviewable before that delivery path is available.

**Done when:** a real admitted batch appears with the right evidence and ordering in the desktop; duplicate, stopped, ambiguous and stale candidates are handled correctly; navigation and retries preserve work.

## 4. Learn from conversations

Attach outcomes to the qualification, hypothesis, query and policy versions actually used. Count attempts, reached conversations, confirmed pain, booked demos, held qualified demos and customers separately. Wrong contact, existing satisfactory support, rejection and no answer are different observations.

Use transcript/meeting suggestions to reduce logging, with short correction actions. Don't make David complete a research form after every call. Preserve his corrections and manual deal decisions. Suggestions corrected later count as incorrect in the separate ten-call suggestion trial; sourcing evaluation does not silently activate suggestion application.

Show sample counts and denominators beside comparisons. Report confirmed pain per reached conversation, held qualified demos per contacted firm, useful-lead yield, correction rate and research cost. Keep multiple touches with one firm from inflating firm conversion. Tag the warm family introduction separately. Missing attribution stays unknown; do not claim a social impression caused a sale.

Initially recommend targeting/query/ranking changes with examples, counterexamples and sample size. David approves meaningful policy changes. Routine processing under the approved policy remains automatic. Small samples justify investigation, not automatic expansion or declaring a winning signal.

**Done when:** real call and meeting outcomes can be traced back to source evidence and policy versions, and corrections update reports without rewriting history. This reporting can ship before enough sales outcomes exist to judge conversion lift.

## 5a. Autonomous email and coordinated follow-up

**Confirmed product intent:** david@usecallie.com; no visible unsubscribe link; select firms and send within configured limits; automatically answer scheduling, straightforward product questions and approved pricing questions. Escalate discounts, unsupported claims, uncertain technical answers and unusual requests.

**Unresolved delivery dependency:** the existing Gmail dispatch blocks cold prospecting. Google's [Workspace developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) excludes unsolicited commercial mail through Gmail scopes. Its separate [acceptable-use policy](https://workspace.google.com/terms/use_policy/) also addresses unsolicited mass email; switching to SMTP is not evidence that the intended use is supported. These are provider constraints, not a claim that every outreach email is unlawful. Preserve David's preferences, but don't call this exact delivery combination verified. Before implementation of cold dispatch, resolve the transport's applicable terms, authentication, reply routing, costs and required message handling. Don't buy a mailbox or silently switch sender.

The application design can be specified independently: approved, versioned messaging and product facts; evidence-backed personalization; one firm/contact conversation plan; existing send fences and reconciliation. An uncertain provider result is reconciled before another send. Draft generation cannot lift a stop, authorize a sender or create a deal.

**Proposed combined-cadence default:** one unsolicited touch per firm per local day, no simultaneous phone/email sequences. Preserve the established maximum four unanswered calls over 14 days, voicemail on attempts 1 and 4. Start email with one introduction and two useful follow-ups over two weeks; timing is an experiment, not a research-proven optimum. An explicit requested callback/reply takes priority and replaces obsolete scheduled work. These email/combined defaults are proposals for the full plan, not claims about a previously approved template.

An inbound human reply immediately holds prospecting. Only supported routine responses can replace it; ambiguous intent goes to review. A booking ends obsolete prospecting and hands off to the existing meeting workflow. Recheck message/thread revision, direct-send takeover, stops and current eligibility at final dispatch. Honor the established phone-only, email-only and firm-wide stop semantics without adding a visible footer link against David's preference.

Warm the actual mailbox through gradual, consistent real sending, reserving capacity for follow-ups and replies. No synthetic engagement network. Read existing ramp configuration before choosing numbers; don't overwrite it with a generic vendor recommendation. Health includes bounces, provider deferrals, complaints when available and mailbox status. Missing Postmaster data is unknown, not a healthy score. SMTP acceptance is not proof of inbox placement. See [Google's sender guidance](https://support.google.com/mail/answer/81126?hl=en).

**Done when:** transport fit is resolved, one controlled end-to-end sequence/reply/booking flow works, stop/edit/takeover races are tested, and real accounting plus ambiguous-send recovery are verified. Domain activation remains a separate explicit action. Existing mailbox use and meeting follow-through can continue independently.

## 5b. Text and image social publishing

Destinations: David's LinkedIn and X profiles; Callie's Facebook Page. Draft material: approved product facts, public research and anonymized themes from calls/demos. No customer names, direct quotes, identifiable anecdotes or invented results. A composite theme is not presented as one real customer's story.

Formats: **text, product screenshots, web images and images from David's phone; no videos**. Start with file upload/paste and ordinary phone-to-Mac transfer. Keep originals, source links and per-platform derivatives; validate supported image types and sizes, normalize phone orientation, and remove location metadata from publication copies. Offer preview, crop and alt text. Product screenshots need a way to cover private data. Web images retain provenance; do not invent license/permission claims. This is a small asset library, not a mobile app or a general image editor.

Use one content workspace with drafts and a calendar. Suggest platform-specific variants rather than posting identical text everywhere. David approves the exact text, image version/crop, destination account and scheduled time. Substantive edits invalidate approval; moving a scheduled item is an explicit reschedule action with a readback. Do not publish from an unapproved regenerated draft.

Persist per-destination states: draft, approved, submitting, scheduled, published, cancellation-pending, cancelled, failed and unknown. Each destination has one submission identity and a provider receipt when available. If native scheduling owns publication, the CRM worker must not also publish at that time. A failed cancellation is not labelled cancelled; an uncertain submission is checked before retrying.

| Destination | Planned route | Verification still required |
|---|---|---|
| LinkedIn | Prefer accessible publishing API or native scheduling | Account/app access, current scopes, token expiry, receipts, edit/cancel behavior |
| Facebook Page | Prefer Page API or native Business Suite scheduling | Correct Page/account, permissions and verified scheduling/readback |
| X | Free native scheduling through a narrowly scoped background browser adapter if reliable | Actual account availability, durable scheduled receipt, cancellation and published readback; no paid API, Premium or scheduler fallback |

[LinkedIn documents native scheduling](https://www.linkedin.com/help/linkedin/answer/a1347212) and [self-serve publishing](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin). Neither proves this account is configured. [X's scheduling documentation](https://help.x.com/en/business-and-advertising/scheduled-tweets) describes Ads scheduling; it does not establish free unattended scheduling for David's account. Facebook's Page API documentation was not retrievable in this research pass. Account checks and an integration probe must precede promises of fully automatic delivery.

For a browser adapter, isolate the task session, keep credentials out of logs, pause on expired login/challenges, and request sign-in without taking over the mouse or screen. Native platform scheduling is preferred so posts already scheduled do not depend on the Mac staying awake. If scheduling/readback cannot be verified at zero X cost, provide a clearly labelled draft handoff and report automatic X publishing as incomplete; do not quietly spend money or claim handoff equals automation.

**Done when:** each enabled destination can schedule an approved text/image post, read back its identity and content, cancel/reschedule reliably and confirm publication without duplicates. Verify with David-approved test content when setup begins. Show limitations by destination; one unavailable integration needn't block the others. No automated DMs, engagement bots, ads or video production in this scope.

## Delivery order and engineering checks

1. Verify the existing discovery release; do not rebuild it.
2. Implement evidence qualification and CRM admission together as the next useful release. Reuse the existing detailed plan after reconciling it with this document.
3. Add conversation attribution and lightweight learning reports. Collect outcome data while later work proceeds.
4. Resolve email transport fit, then implement coordinated cold outreach and routine replies. This external dependency does not delay steps 1–3.
5. Implement social assets/drafts/approvals, then verified delivery adapters. Check account capabilities early so adapter availability does not surprise us at the end.

Before execution, produce build steps covering all five parts, with file boundaries, migration needs, meaningful tests and dependencies. Keep external capability probes separate from production activation. Use existing release checks and one independent whole-branch review per release; no per-task review bureaucracy or release-system rebuild. Only required schema changes get migrations, assigned from current main at implementation time.

Across new code, test workspace isolation, duplicate jobs, stale results, concurrent corrections/stops, budget exhaustion and ambiguous provider responses. Verify the user flows in the real app after fixture tests. Published code, configured accounts and verified live operation are separate statuses.

## Remaining decisions versus engineering work

The interview has enough product direction for this overall design. The proposed combined cadence and image/approval behavior above need review with the full draft. The remaining external questions are transport compatibility and actual social account capabilities; research/probes should narrow those before asking David to choose a fallback. No credentials or purchase are needed just to finish this plan.

Detailed interview answers and source limits are in [planning notes](../../sourcing/roadmap-planning-20261005.md). No product code, account settings, sending controls or social posts were changed for this draft.
