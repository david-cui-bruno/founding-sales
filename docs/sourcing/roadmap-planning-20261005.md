# Sales roadmap: planning decisions and research

Status: active planning, not an approved complete design. David requested planning all five roadmap items, with questions one at a time and research into unresolved choices, before further implementation. The existing qualification/admission implementation plan is input to this broader design, not permission to begin it during the interview.

## Full scope

1. Finish discovery verification: scheduling, quota accounting, persisted results and desktop readback. Discovery was enabled on 5 October; the first production result was not yet verified at activation.
2. Targeted research: defensible firm fit, maintenance-related signals, identity, freshness, contrary evidence and useful opening questions.
3. Call-queue admission: published business routes, duplicate/stop/ownership checks, deterministic ranking and supported automatic admission.
4. Learn from conversations: signal cohorts, confirmed pain, held qualified demos, customers, research cost and lightweight correction feedback. The ten-call suggestion trial remains separate.
5. Outreach and distribution: autonomous email, followed by Facebook/LinkedIn/X content drafting and scheduling. Email and social each need their own design within the overall roadmap.

Preserve A before B: better-qualified leads entering the call queue before autonomous email. UI improvement runs throughout with React/shadcn, without another framework change. Use existing AWS/GCP credits and free allowances, with no newly authorized cash spend or subscriptions. Keep existing outreach controls unchanged during planning.

## Confirmed decisions

- **Qualified demo (David: A):** a held demo involving someone in the buying decision, a real maintenance-workflow need, and openness to a paid solution. Record booking, attendance and qualification separately; a booking is not a qualified demo. Do not invent a minimum budget, door count or buying deadline from this definition.
- **Channel allocation (David: A):** once autonomous email is ready, prioritize David's calls for the strongest leads; other qualified firms may begin email without waiting for a call. Coordinate both channels in one per-firm schedule and conversation history. This does not lift current sending controls, authorize a provider change, or require independent simultaneous sequences.
- **Learning autonomy (David: A):** initially analyze conversion/call evidence and recommend changes to signals, searches and ranking; David approves meaningful targeting changes. Approval applies to targeting-policy changes, not individual leads or routine processing under the agreed policy. Do not silently enable adaptive targeting or treat unanswered calls as confirmed lack of need.
- **Social identity (David: A):** use David's founder voice on his LinkedIn/X profiles and a Callie business Page on Facebook. This selects the intended destinations for the design; account/Page availability still needs verification during setup. It does not authorize creating a duplicate personal Facebook account or publishing during planning.
- **Social draft material (David: A):** drafts may combine anonymized themes from sales calls/demos with public research and approved product facts. Exclude customer names, direct quotes and invented results; David approves drafts before publication. Remove identifying details beyond names and avoid presenting a composite theme as one real customer's story. This is drafting scope, not authorization to publish any current transcript or post.
- **Cold-outreach reply autonomy (David: A):** automatically handle scheduling, straightforward product questions and approved pricing facts. Route discounts, custom commitments, uncertain technical answers and unusual requests to David. A working AppFolio integration may be described accurately; unbuilt integrations or special commercial terms cannot be promised. Use versioned approved product/offer facts, and hold unsupported answers for review rather than improvise. This applies when the outreach feature is built and enabled; it does not change current send controls.

## Research findings and limits

- [Gojiberry / Mindflow case study](https://gojiberry.ai/case-study-mindflow): combines observed signals, ICP filtering and contextual outreach. Vendor-reported results are useful hypotheses, not causal evidence or Callie conversion forecasts. The customer's enterprise security market differs from small property managers.
- [Gong: call/email benchmarks](https://help.gong.io/docs/engage-analytics-benchmarks-and-best-practices): associates calls within an outreach flow with better email reply rates. This supports testing coordinated channels; it does not establish the best cadence or channel allocation for property managers.
- [Gong: cold-calling analysis](https://www.gong.io/blog/the-hidden-power-of-cold-calling-insights-from-300m-calls?content_language=English): reports higher email reply rates for prospects also called, including unconnected calls. Treat as observational vendor data with possible selection effects, not a guaranteed improvement.
- [LinkedIn native scheduling documentation](https://www.linkedin.com/help/linkedin/answer/a1347212): supports scheduled personal-profile posts. Native scheduling is a possible delivery mechanism; this is not proof of a reliable unattended browser integration. Account capabilities, edit/cancel behavior and receipts still need verification.
- [2025 Edelman–LinkedIn research](https://www.edelman.com/expertise/Business-Marketing/2025-b2b-thought-leadership-report): survey evidence supports testing useful expert content for B2B buyers. It is not a PM-specific conversion study and does not establish that personal profiles outperform company Pages. The founder-voice choice is David's product preference, not a causal conclusion from this study.
- [Gmail developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy), checked 5 October: Gmail scopes exclude applications distributing unsolicited commercial mail. This is distinct from Gmail recipient-side bulk-sender thresholds; staying below 5,000/day does not resolve this API-use condition. David's recorded preference remains david@usecallie.com and no visible unsubscribe link. Do not label that cold-sending combination provider-approved based on its low volume or silently change his preference. Resolve the delivery design explicitly before declaring autonomous cold email ready.
- [Google sender guidelines](https://support.google.com/mail/answer/81126?hl=en): support gradual, consistent sending with feedback/error monitoring, not a universally safe daily volume. The separate [sender troubleshooting guidance](https://support.google.com/mail/answer/15256272?hl=en) notes low-volume senders may lack Postmaster dashboards; absent data must be shown as unknown, not healthy. Plan response to bounces/deferrals and budget for follow-ups within the total cap.
- [LinkedIn self-serve publishing](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin): documents OAuth `w_member_social` and a returned post identifier. This establishes a supported integration route to investigate, not verified access for David's app. Check current endpoint/version availability, token expiry, edit/delete and readback permissions before selecting the adapter.
- [X API pricing](https://docs.x.com/x-api/getting-started/pricing), checked 5 October: pay per use; ordinary post creation is listed at $0.015/request and posts with a URL at $0.200/request. Thirty such creation requests would be $0.45 without URLs or $6 with URLs, before reads/other actions. Rates and checkout details need rechecking at setup. AWS/GCP credits do not establish coverage for X charges. A prepaid credit purchase and subsequent consumption are different cash events; do not pretend the current usage ledger controls a provider checkout.
- Facebook's public Page-post API documentation could not be retrieved in this research pass; the Help page redirected to login. Native Page scheduling and API permissions require verification from accessible official documentation/account state. Do not infer production readiness from third-party tutorials.

## Code findings relevant to the full plan

- `packages/domain/settings/cashCeiling.ts` already counts cash usage plus open reservations against one monthly ceiling. A social adapter must participate in that accounting and have its own smaller cap; there is no social billing support today.
- `packages/domain/sequences/eligibility.ts` and `packages/domain/outbound/stepPermission.ts` currently hold prospecting email before Gmail dispatch (`cold_outreach_mailbox_required`). Autonomous cold outreach needs an explicit reviewed transport/eligibility design, not merely turning on the domain switch.
- The existing post-demo follow-through design covers routine recaps and bounded nudges; it does not implement general autonomous replies to cold prospects. The approved-facts reply engine is new scope and needs separate reply/stop/takeover concurrency tests.

## Open design/research work

- Unified contact history, combined cadence limits and transitions after replies/calls, implementing the confirmed channel allocation above.
- Evidence quality versus useful coverage, and how to evaluate fit-only comparison leads without fabricating buying intent.
- Feedback attribution and denominators: distinguish not reached, wrong contact, already covered, confirmed pain, held demo and purchase.
- Email provider fit, sending health, sustainable ramp, messaging/sequence experiments, costs and failure recovery. Historical send-path documents are not current provider-policy verification.
- Social source material, approval scope, scheduling integration options and publish/cancel/retry verification; verify the availability of the confirmed account destinations before setup.
- Stage-specific acceptance criteria and a release order that allows each stage to work while later stages are developed.

No cold email, social post, configuration change or new implementation was initiated by these planning notes.
