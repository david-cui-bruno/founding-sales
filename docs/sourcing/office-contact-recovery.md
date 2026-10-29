# Bounded office contact recovery

Historical implementation and diagnostic context. Current operations and pending owner evaluation belong to [current-state](../operations/current-state.md); exact qualification versions come from [qualificationVersions.ts](../../packages/domain/sourcing/qualificationVersions.ts). This note is not a current rollout, acquisition or replay instruction.

The location-before-email parser supports an additional exact seven/eight-block contact-card layout: company name, street, suite, city/state, `Contact Information`, one/two phone numbers, then one published email. It retains the original address block citation and classifies the route as an office contact, never a named person.

This is a separate grammar, not a larger generic page window. Exact resolved company name, first-party contact URL, matching website/email domain, complete source and seven-day freshness remain required. Other offices, prose, duplicate locations, extra streets, multiple emails and over-bound cards refuse. Existing compact layouts and their refusals remain unchanged.

This behavior is `outreach-email-fit-v2`. Control validation rejects v1 evaluation bindings; audit and offline evaluation reports use the current policy constant. The qualification prompt at this recorded checkpoint was `qualification-growth-v6`; current source uses `qualification-v5` / `qualification-context-v7`. A later rollout/activation requires a fresh exact-implementation evaluation and real configuration binding; the deployed v1 disabled report cannot authorize v2.

## Recorded diagnostic and historical follow-up

The October8 Boston discovery contact observation `e4bcb12a-78be-40ef-b13c-182388cc8e3d` contains this layout in b18–b25. Its original qualification remains review: an SEO candidate name and selected truncated-page quotes prevent supported identity/fit/geography, and the old card parser cannot associate the published email.

A frozen replay with the explicitly corrected company name and hand-selected complete contact-page quotes demonstrates recovery under the unchanged targeting criteria. It is not model extraction accuracy, a production correction/new qualification, ordinary discovery yield or activation proof. Original measurements remain15 new unique URLs, five review candidates and zero eligible/supported email routes at the recorded read.

At this recorded checkpoint, remaining work was to recover supported company names through revision-bound correction and improve extraction of explicit residential/geography evidence from complete pages, then verify ordinary fresh qualifications. Different-domain email addresses remain unresolved under the current route safeguards. No candidate, enrollment, sending control, provider dispatch or production rollout changes are part of this source change. Automatic admission was off at that checkpoint; its current owner/evaluation gates are recorded in current-state.

Tracked in [#436](https://github.com/david-cui-bruno/founding-sales/issues/436). Local recorded replay and red/green receipts are in `.context/436-recorded-replay.json`, `.context/436-contact-red.log` and `.context/436-contact-green.log`; these are not available in a fresh clone.
