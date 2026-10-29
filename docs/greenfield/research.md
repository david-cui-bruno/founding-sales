# Firm research and research-only discovery

Research prepares sourced business facts, judgments and a call brief. Discovery proposes candidates; qualification evaluates evidence; Keep/admission and a CRM firm are distinct states. None grants permission to contact someone. A completed run is not a useful brief, a reachable phone or a callable firm. Operational authority and measured supply belong in [current state](../operations/current-state.md), not inferred from this source page.

## Existing source boundaries

[Prospect prioritization and buying-role review](prospect-prioritization.md) records agreed, PLANNED requirements under848. Priority will order a broad plausible pool; missing intent/Person/phone is not commercial rejection. This is separate from the deployed source/qualification/admission and execution gates below. The ranking and coverage redesign is not yet implemented.

`packages/domain/research/` owns enqueue, runs, page/source policy, extraction, facts, judgments, brief and spending. `packages/domain/sourcing/` owns candidate discovery, qualification, identity reconciliation and research-only verified-firm intake. Actual adapters and scheduler registration are assembled in `apps/worker/src/bootstrap/main.ts`.

Candidate names, geography and selected website context are untrusted selectors, not evidence. Qualification facts must cite retained literal source blocks with the required semantic role. Preserve contrary identity and residential-service evidence. No fuzzy canonicalization, invented citation or model assertion can substitute for deterministic proof. Incomplete/truncated observations cannot be relabeled complete after discarding content.

Verified-firm policy checks current first-party complete evidence, exact identity/geography, residential management and strict office-phone association. Service-area marketing alone does not establish a physical office phone. Foreign offices, conflicting identities and ambiguous numbers remain held/manual. A verified identity may still have no phone. New prompt/policy bindings invalidate old evaluation authority; a historical positive count cannot attest a new extractor.

## Stop before paid work

`research/firmState.ts` rejects unknown/merged/suppressed firms and applicable research holds for the workspace, firm, actual current assigned owner and real research channel. The requester is not owner authority. Unassigned firms do not inherit arbitrary owner holds. Sourcing candidate checks use their supported workspace/channel subject, not an invented candidate owner.

`research/eligibility.ts` rechecks the stored switch and current eligibility before provider boundaries. `research_disabled` means the action is switched off **or held**, not necessarily that stored enabled=false. Dispatch gates coordinate committed stop facts with work. Checks after waits and between page/count/model calls remain necessary. Never clear uncertainty to force a retry.

## Budgets and results

The daily ceiling counts shared qualification/research **run units**, not unique firms. A fresh firm normally uses qualification plus brief, two steps, and failures/other work reduce throughput. Daily/monthly dollar ceilings, per-firm/page bounds, provider reservations and the separate MODEL credit guard are distinct limits. Stored limits do not prove invoices or remaining cloud credits. Unknown/estimated and already-incurred costs survive a hold; only unused attempts may be released.

Settings exposes research on/off and budgets plus read-only discovery status. Turning research off also pauses new discovery searches/checks, while enabling it bypasses neither discovery holds nor search allowances. Independent discovery allowance changes are not available in that client surface.

## Verification

Existing research/sourcing domain, API, worker and renderer tests exercise actual disposable-PostgreSQL transactions with controlled provider ports. Cover assigned-owner/reassignment, postqueue/between-provider holds, unrelated-channel exclusions, zero fresh paid calls and retained settled/estimated cost. These are source proofs, not provider traffic, fresh real-evidence quality, actual intake activation or outreach consent.
