# FSS: a meeting-first acquisition system

**September 8, 2026 · Written design for review · Not an implementation or activation approval**

## 1. The product in one minute

**FSS should help David wake up to relevant meetings, not a list of research chores.** It acquires customers for Callie, the 24/7 maintenance agent that handles tenant requests and coordinates contractors, including calling them when needed.

FSS researches suitable property-management firms, finds useful business contact routes, prepares daily calls and small multichannel campaigns, drafts replies, and books meetings within agreed rules. David makes the calls, approves important messages and attends the meetings. A qualified conversation can lead to a small, explicitly scoped pilot.

The first audience is **independent/regional residential PM firms, especially multifamily or mixed rental portfolios**. Commercial is secondary. Prospecting can be nationwide, with Providence/Boston proximity a useful bonus. Neither a fixed unit-count cutoff nor a specific daily call quota has been established.

The first release includes **small campaigns**, not a bulk-email stack:

- Human-initiated calls from FSS on the Mac using David's existing iPhone service and number.
- AI-prepared LinkedIn messages, manually sent in LinkedIn.
- Permitted email correspondence, requested follow-ups, approved substantive replies and automatic scheduling.

Genuine cold-email delivery remains an optional, separately gated transport. It is not a prerequisite for the campaign product. There is no approved cold-email provider or multi-mailbox purchase.

**Build on the existing FSS, not a rewrite.** Keep its data, evidence, durable drafts, truthful activity records and recovery system. Replace the owner-centric acquisition model and distracting defaults.

## 2. Decisions and boundaries

This consolidates the September 8 interview: Mac plus small worker approved at 22:20 UTC, residential-PM-first at 22:26, the daily workflow at 22:30, small campaigns at 22:36, and AI-prepared/manual LinkedIn at 22:42. The engineering contracts below are proposals for written review, not previously implemented capabilities.

| FSS handles | David handles |
|---|---|
| Routine company research, contact-route discovery, deduplication and prioritization | Audience/offer/sequence approval for a campaign |
| Editable, context-aware first drafts | Individual approval of warm/important outreach and substantive replies |
| Preparing calls and LinkedIn steps | Each actual call and LinkedIn send |
| Approved follow-up execution and reply interruption | Product, pricing, pilot-scope and other material commitments |
| Pure scheduling within explicit rules | Meetings and genuine judgment that cannot be resolved from evidence |

Campaign approval does not authorize arbitrary new audiences, unlimited AI rewrites or a forbidden sending channel. Public contact information is not proof of recipient consent. No automated prospecting voice, recording, automated SMS, LinkedIn bot or whole-mailbox training is included.

The incremental non-AI budget target is approximately **$20/month**. Eligible AI credits can support research and drafting, but their coverage/expiry is unverified and they do not pay unrelated subscriptions. This is a target, not an all-in quote.

## 3. What a normal day feels like

The home screen answers three questions:

1. **Who should I call?** A short ranked queue with company, relevant person or business route, useful portfolio/operational context and a specific reason to talk. Calls remain available daily alongside warm obligations.
2. **What needs my answer?** Editable messages requiring judgment, with the relevant thread and a proposed answer. LinkedIn steps are clearly marked as manual.
3. **What meetings are coming?** Real calendar status and a concise preparation brief, including who is attending, what is known, what they asked and the purpose of the conversation.

Research, campaign configuration, detailed pipeline and history remain accessible on demand. Routine enrichment failures belong in operational status, not hundreds of founder approval cards. If a contact route is missing, FSS tries permitted alternatives within budget or parks the account with a reason. It does not ask David to click “Find contact info” for every person.

Keep the selected Bauhaus visual identity and existing light/dark/system and density preferences. Reduce default content and action clutter. Show one primary action for the current step, with alternatives nearby rather than duplicate controls. Preserve selection, edits and focus through refreshes. **Exact layout and navigation are not yet approved** and need a focused mockup review before UI implementation.

## 4. Research the account, then the person

The acquisition unit becomes a **PM account**, not a parcel or owner name. Research records should distinguish:

- Company identity/domain, service area and residential/commercial mix.
- Managed portfolio evidence, including whether a figure means properties, buildings or units. Unknown stays unknown. Ownership is not management.
- Maintenance intake, coordination process, internal teams, vendors and published technology, when evidenced.
- Relevant operating leaders and role evidence. A title is not verified purchasing authority.
- Published business phone/email routes and permitted or user-supplied profile links, with provenance and freshness.
- An observed fact, a hypothesis to test, and an actual prospect-stated problem as different kinds of evidence.

Start with permitted company/service/team/careers sources and direct business routes. Do not use tenant emergency lines to pitch, personal relatives as a PM contact strategy, or directories whose terms prohibit solicitation use. NARPM's public PM directory is not an outreach-list source. Tracerfy's existing property-owner lookup is an optional legacy capability, not the PM decision-maker engine.

Rank genuine due promises and active conversations first, then account fit, contactability, supported operating relevance and pilot plausibility. Local proximity is a bonus. Do not fabricate precise buyer intent from a website. Keep a configurable daily new-call allocation instead of allowing any active warm lead to suppress all cold work. An urgent workload conflict should be visible, not silently erase the prospecting queue.

The working hypothesis is an unresolved tenant-intake or maintenance-coordination gap that a bounded Callie pilot can address. “They advertise 24/7 service” is not evidence of failure. Existing maintenance software is neither automatic exclusion nor proof of a gap. Conversations must validate the hypothesis.

## 5. One small campaign across channels

A campaign contains an audience definition, offer, objective, bounded cohort, ordered conditional steps, approved message constraints, per-channel limits and stop rules. FSS proposes it from research. David reviews the strategy and representative drafts instead of routinely qualifying every record. An illustrative 20–30-account cohort is an experiment proposal, not an agreed quota.

For v1, allow one active acquisition enrollment per account. Select the most appropriate contact and route, rather than messaging everyone at the firm on every channel. Switching contacts preserves the account's history and prevents parallel contradictory outreach.

An example, not a fixed cadence: call an appropriate business route; if information is requested, prepare an email for approval; use a contextual LinkedIn step where appropriate; schedule a follow-up based on the actual outcome. A reply moves the account out of unattended acquisition and into conversation handling. Booking a meeting stops obsolete acquisition steps. A reported opt-out suppresses the relevant person across channels, and the account when the request covers it, under the synchronization and dispatch contract in section 7.

Campaign approval is a versioned snapshot of audience boundaries, offer, steps, caps and allowed content. Expansion or material changes require renewed approval. Individually approved emails bind the exact recipient, content and relevant thread revision. A newer reply or changed material context makes the approval stale.

**LinkedIn is deliberately manual.** FSS prepares a concise draft and opens the appropriate profile/thread. David sends in LinkedIn's own UI and records the outcome or supplies a reply. Copying/opening is not sending. Without authorized inbox observation, absence of a recorded reply is not confirmed silence: further steps that depend on that outcome wait for reconciliation. User-reported replies pause relevant cross-channel acquisition. Do not promise immediate automatic detection of an unseen LinkedIn response.

Kith provides useful campaign/enrollment, sequence and approval concepts. Adapt these inside FSS, not a second app. Do not import its job-hunt rules, private contact lists or browser sender. Its inspected planner sometimes advances state at enqueue time; FSS must preserve the stronger distinction between prepared, queued, human-reported sent, provider-accepted, replied, booked and held.

## 6. Calls, email intelligence and booking

### Calling

Wire and prove a real FSS → Apple Phone/FaceTime → own-iPhone handoff. Check device readiness and show an actionable setup problem, not a misleading enabled Call button. There is no separate paid dialer requirement if the existing devices/carrier support this path. If the handoff is unavailable, copying the number is an honest fallback, not acceptance of the requested integration.

Each call is human initiated and remains subject to applicable calling rules, suppression and recipient-local time windows. A handoff result is not proof of a connection. Start with quick outcome capture and optional typed/dictated recap. Do not depend on unproven call-state APIs or recording to make the basic workflow useful.

### Email intelligence

Extend the existing durable composer and send ledger with relevant thread context. FSS distinguishes substantive questions, scheduling, rejection/opt-out, out-of-office and delivery failures. Observed new replies interrupt stale acquisition work before further dispatch. Thread association uses provider references and participants, not subject text alone. Ambiguous identity or intent waits for a useful approval, not an automatic sales commitment.

Draft using approved Callie product facts, source-backed account context, relevant thread excerpts and curated style examples. Do not invent integrations, service coverage, pricing or operational guarantees. Warm/important messages and substantive replies stay editable and individually approved. Out-of-office is not interest, and a provider-accepted email is not an inbox-placement or reading guarantee.

Start style learning with a small user-selected set of emails and draft-to-edit pairs. Do not ingest a whole mailbox or fine-tune as a prerequisite. Evaluate factual support, correct recipients/threads, unsafe commitments and editing burden on held-out examples. New personal-data access requires explicit permission.

The implemented Gmail connection requests send-only access. Reply reading requires a new grant. Google policy does not establish permission for unsolicited commercial campaigns through Gmail, including low-volume or DIY SMTP arrangements. Use Gmail for permitted correspondence and requested follow-ups. Buying aliases or more inboxes does not solve this boundary.

### Booking

FSS may answer purely logistical scheduling replies and book only after clear meeting intent and an agreed slot, or explicit permission to choose a slot within the prospect's constraints. Interest alone is not permission to select any free time. Saved scheduling rules still apply. Mixed product/scheduling replies retain approval. The setup must explicitly define timezone, availability, duration, buffers, notice, horizon, conflict calendars, location/link and cancellation/rescheduling rules. No booking runs before those rules are confirmed.

Recheck conflicts immediately before creation, serialize competing bookings, use durable event identities and reconcile uncertain provider results before retrying. External calendar edits can still race with a free/busy check, so detect and handle resulting conflicts rather than promising an impossible atomic reservation. Process cancellation and rescheduling as updates to the existing meeting identity.

Show event created, invite/attendee response, cancellation and meeting held separately. Do not convert an old `interview_booked` activity into a confirmed calendar event. A booked event is not a held or qualified meeting.

## 7. Architecture and ownership

**Selected approach: Mac workspace plus a small background worker.** Mac-only is cheaper/simpler but cannot reliably meet the asleep-laptop outcome. A purchased CRM/dialer/sequence stack adds cost and fragmentation without resolving the core fit and workflow questions.

The Mac owns the call/approval experience, private local material and a synchronized view of delegated work. The worker handles explicitly delegated research, relevant email intake, approved dispatch and scheduling. Existing cloud patterns are candidates for reuse, not permission to alter Callie's production service or deploy infrastructure.

| Boundary | Responsibility |
|---|---|
| Account/evidence service | Source-backed companies, contacts, relationships and research results |
| Campaign planner | Versioned strategy, enrollment, next work and account-level interruption |
| Approval/dispatch service | Immutable approvals, one execution owner, suppression, durable outcomes |
| Communication adapters | Actual phone handoff, mail/thread operations and manual LinkedIn records |
| Meeting coordinator | Rules, availability, event identity and reconciliation |
| Mac projections | Responsive daily work, edits, approvals and honest connection status |

For delegated campaigns, the worker is the authoritative execution and suppression owner. The Mac submits versioned, idempotent commands and consumes durable events. It does not also dispatch those emails or book those meetings. Existing local-only drafts/actions remain outside worker execution until explicitly delegated. Once an account is delegated, email dispatch goes through its execution owner, including sends initiated in the Mac UI. Human call/LinkedIn outcomes update that owner before dependent automation resumes. There is no automatic fallback to a second sender when a worker is unreachable.

Recheck approval, campaign state, current context, suppression and authority at the dispatch boundary. Replies, opt-outs and outcomes received locally block incompatible local work immediately and synchronize to the worker when connected. The worker applies received suppression before further dispatch. Unobserved external events cannot be guaranteed to stop an already in-flight action, so reply-intake freshness is a dispatch prerequisite, not proof of instantaneous observation. Pause/revocation must stop future actions once received by the execution owner, including queued ones. A pause made while offline is visibly **pending**, not falsely confirmed. Provide an authenticated worker-reachable pause/revoke route during activation. An already accepted external action cannot be unsent; persist and report late outcomes truthfully. Unknown send/create results are reconciled, never blindly retried.

Do not copy the whole local database, private notes, entire mailbox or OS-encrypted credential envelope to a server. Delegate only necessary account/campaign/thread/calendar state and credentials through a separate authorized setup. Gmail read grants are broader than the app's intended processing: make that distinction explicit and enforce bounded ingestion/retention. Unrelated mail is not a research or training corpus. Missing grants, expired credentials or disconnected services pause dependent automation and surface one actionable connection issue.

## 8. Keep, replace and retire safely

Source baseline audited: `78592fb00f18beb165f02f53c88349cd8f2d2925`. This was source inspection, not a new live integration test.

| Existing FSS | Disposition |
|---|---|
| Person/contact/property IDs, source receipts, aliases, immutable history, suppression | Keep and extend with explicit account/contact-role relationships |
| Encrypted SQLite, backups, migration/replay/recovery, durable drafts and uncertain-send state | Keep, including during desktop/worker integration |
| Minimal Organization and person-centric cycles | Add account opportunity/enrollment semantics with an explicit migration map |
| Owner/parcel ranking and property-evidence processing | Replace default local and cloud ranking with PM-account evidence and contactability |
| Date/cadence primitives and callback history | Reuse, version new playbooks, remove global warm suppression of daily cold work |
| Composer/OpenAI/Gmail-send code | Extend with thread context, approvals and permitted dispatch |
| Phone abstraction with unavailable production bindings | Finish and verify actual device handoff |
| Review Inbox and logged interview outcomes | Do not mislabel as an email inbox or real calendar integration |
| Parcel/violation sourcing, generic discovery homework, contractor job/fill-rate scoreboards | Retire from the primary FSS workflow, preserve historical data and optional adapters |
| Shell, themes, tables, inspector | Reuse foundations, simplify the default experience after layout review |

The account migration must not automatically equate an LLC owner, management company and employee. Preserve unresolved identities, old IDs, relationships, suppression and catalog versions. New account projections must not rewrite historical lifecycle events or pretend past records were meetings/pilots.

**No blind Git rollback against a migrated workspace.** First hide obsolete defaults, stop scheduling superseded work through an explicit transition, and prove upgrade/recovery. Delete unreachable code only after dependency checks. Fresh authorized backups and a restore drill precede real-workspace migration. Recovery planning must cover delegated worker state and grants as well as local data, without reviving paused campaigns or unknown sends. Existing documentation with outdated UI/schema claims is updated alongside the corresponding implementation slice, not used as runtime truth.

## 9. Delivery slices within v1

This is an umbrella product design, not a single giant coding ticket. Each slice receives a bounded implementation plan and a reviewable end-to-end contract. Routine engineering details do not require another product interview.

1. **Prove the execution foundations.** Controlled own-number Mac call handoff, selected mail/calendar permissions, budgeted worker hosting, data/credential boundary and pause/revocation. Use consenting test endpoints only after authorization. A UI over an unavailable integration does not pass.
2. **Make the daily acquisition loop useful.** Account identity/evidence, automatic PM research, corrected ranking, daily cold calls alongside warm work, campaign/enrollment skeleton and editable outreach. This replaces routine founder research chores. Review the home layout before building it.
3. **Close one real conversation-to-meeting loop.** Permitted follow-up, relevant reply ingestion, substantive approval, rule-bound scheduling, real event reconciliation and meeting brief. Prove the Mac-asleep case and shared state after reconnect.
4. **Complete small multichannel campaigns and simplify defaults.** Manual LinkedIn preparation/outcome capture, conditional steps, cross-channel interruption, approvals/limits, useful reporting and data-safe retirement. Small campaigns are part of v1, not deferred with cold-email transport.

Cold-email infrastructure, auto-LinkedIn, recording/transcription, autonomous SMS, fine-tuning, bulk volume and extra mailboxes are not v1 dependencies. Expand only on evidence and separate permission, not because an integration happens to exist elsewhere.

## 10. Acceptance and measurement

| Requirement | Observable acceptance evidence |
|---|---|
| Automatic useful preparation | A permitted PM-source cohort becomes account/contact records and a short reasoned queue without per-record founder review. Unsupported ownership, roles and addresses remain uncertain. |
| Daily calling | A consenting endpoint receives the actual human-initiated own-number call. Handoff/cancel/failure and recorded outcome stay distinct. Warm work does not erase a configured daily new-call allocation. |
| Editable approvals | Saved/reopened exact draft content and recipient survive account switches/restart. New context invalidates stale approvals. No approval-required message is dispatched without the matching revision. |
| Small campaigns | One account cannot receive conflicting concurrent acquisition steps. Pause, opt-out, reply, booking and restart stop obsolete work, including dispatch races. |
| Manual LinkedIn | Copy/open leaves the step unsent. Recorded outcome advances only the appropriate step. Unknown inbox status cannot silently authorize a follow-up. No browser bot is invoked. |
| Useful replies | Real relevant threads associate correctly, unrelated mail is excluded, and substantive or mixed replies become editable approvals rather than autonomous commitments. |
| Real booking | Approved rules produce one actual event, handle timezone/DST/conflict/reschedule/cancel cases, and reconcile uncertain creation without duplication. Booked, accepted and held stay distinct. |
| Overnight operation | Delegated approved work continues with the Mac asleep. Reconnect restores truthful state without a second dispatcher. Confirmed pause/revocation blocks future actions. |
| Upgrade safety | Historical identities, activities, drafts, suppression and catalogs survive migration and restore. Old unknown sends and paused work are not revived. |
| Usability and economics | The actual packaged app supports the daily loop in both themes and narrow/wide windows. Measure founder time, edit burden, useful conversations, booked/held meetings, pilot starts, cash cost and model usage. |

Fixtures and source tests establish contracts; they do not prove live device behavior, provider permissions, mailbox delivery, calendar booking or business conversion. Each live acceptance run requires its own bounded authorization. No prospects are contacted merely to make an automated test pass.

Judge acquisition experiments at the account level over comparable observation windows. Track actual calls/conversations, positive responses, meetings booked and held, pilot willingness/starts, time and cost. Pilot starts require evidence of an actual start, not an AI suggestion, booked meeting or unsigned offer. Replies, connection counts and emails sent are not the outcome. Do not prescribe a conversion rate from unrelated vendor benchmarks or claim that calls necessarily outperform email for Callie before testing.

## 11. What still needs a choice

- **Written design review now.** Confirm this is the product to implement, or amend it.
- **Before the relevant slice:** a focused home-layout review, and concrete adapter/hosting selections within the budget. Present any purchase trade-off before spending.
- **Before live activation:** actual accounts/grants, consenting test endpoints, worker deployment, scheduling rules and campaign launch approval.
- **Optional later:** curated personal writing examples, a permitted cold-email sender and any additional paid lookup budget.

These do not reopen the agreed audience, daily calls, small campaigns, manual LinkedIn or Mac-plus-worker direction. Nothing in this document activates a connection, purchases a service, sends a message, books a meeting or authorizes destructive rollback.

## 12. Evidence behind the design

Public sources reviewed September 8, 2026. Claims below have deliberately limited scope.

- [Buildium 2026 industry preview](https://www.buildium.com/resource/2026-property-management-industry-report/): maintenance matters to owners choosing PMs. Vendor survey evidence, not Callie purchase intent or a proven unit-count band.
- [GC Realty maintenance operations](https://www.gcrealtyinc.com/maintenance-services): concrete internal/external maintenance roles and workflows. An illustrative firm, not an asserted unserved prospect.
- [AppFolio maintenance](https://www.appfolio.com/property-manager/maintenance), [Latchel](https://latchel.com/) and [EliseAI maintenance](https://www.eliseai.com/maintenance): advertised competing automation means generic “24/7 AI” is not established differentiation.
- [Apple device calling](https://support.apple.com/en-us/102405): supports the own-iPhone direction subject to device/account/carrier setup. Does not prove FSS's currently unavailable production binding.
- [Gmail Program Policies](https://www.google.com/gmail/about/policy/) and [Workspace developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy): do not establish permission for the proposed unsolicited commercial sender. Sender approval and low volume do not change this.
- [Workspace flexible pricing](https://support.google.com/a/answer/1247362?hl=en) and [alias documentation](https://support.google.com/a/answer/33327?hl=en): one Starter user lists at $8.40/month before extras; aliases are not independent mailboxes. No purchase is required just to design campaigns.
- [LinkedIn agreement, section 8.2](https://www.linkedin.com/legal/user-agreement) and [API access](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access): unauthorized browser sending is not an acceptable shortcut; ordinary self-service access does not establish general DM/inbox access.
- [Tracerfy API](https://tracerfy.com/skip-tracing-api-documentation/) and [NARPM directory](https://www.narpm.org/find/property-managers/): owner lookup and a solicitation-restricted directory do not solve PM buyer discovery.
- [Belkins 2026 response study](https://belkins.io/blog/cold-email-response-rates): a vendor dataset reports 0.45% unique replies per emails sent, not meetings or PM-specific conversion. Its denominator changed from older studies. It does not prove a Callie channel winner.

Source anchors at the audited FSS baseline: `identityTypes.ts`, `builtinPrioritizationRules.ts`, `todayOrdering.ts`, `builtinCadences.ts`, `startApplication.ts`, `outreach/emailService.ts`, `providers/googleOAuth.ts`, `providers/gmailProvider.ts`, `phoneHandoffLauncher.ts`, `domainRuntime.ts` and `routeRegistry.tsx`. Additional research was unavailable in production, phone bindings unavailable, Gmail OAuth send-only, and no actual calendar integration was found. Kith concepts were inspected separately at `c022699`; source inspection did not establish a working or authorized live deployment.
