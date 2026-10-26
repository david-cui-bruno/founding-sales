# FSS feature and journey map

**Canonical entrypoint for feature discovery, reproduction and acceptance.** Start here, then use the linked journey and existing harness. This is navigation, not a second SPEC, backlog, release procedure or execution ledger. It grants no runtime/provider/contact authority.

## User goals and coverage

| Group | User journey / current surface | Coverage boundary |
| --- | --- | --- |
| Daily work and callbacks | [Today → exact prospect/context → next action](selling.md#today-and-next-action) | Browser source/retained local acceptance; hosted reads retained. Displayed callback intentions are not executed reminders. |
| Supply, sourcing and research | [Prospects: prepared research, retained review, source inventory, qualification/recovery, phone discovery](selling.md#supply-and-prospects) | Partial continuous supply. Raw prospects remain usable with unknown phones/qualification; completed batch prepared0/10, cap exhausted, target unmet. |
| Calling and actual outcomes | [Calling: current evidence/device/verdict → actual outcome → private promised email](selling.md#calling-and-follow-through) | Controlled fake-device acceptance, not real audio/call usefulness. iPhone lane closed. |
| Outbound and follow-ups | [Email: Automatic outreach / Follow-ups; desktop Sequences](selling.md#email-and-sequences) | Eligible automation target, approved-choice opening source, no live dispatch claim. Owner OFF preserved. |
| Incoming conversations | [Email → Replies: original/context → manual reply review](selling.md#email-and-sequences) | Manual incoming retained. Controlled original fixtures do not prove real-original usefulness. Automatic incoming/booking/coaching deferred. |
| Public social and founder voice | [Social → Posts / Conversations, private voice guide and durable drafts](selling.md#social-and-founder-voice) | Private lifecycle partial. Supported automatic publishing target, not active. Public thread reader missing; not DMs. |
| Firms, people, contacts, routes, opportunities | [Record/relationship context and Pipeline](relationships-and-controls.md#records-and-human-work) | Existing CRM/desktop surfaces. Browser is not a complete CRM/Pipeline replacement. An endpoint/relationship grants no outreach. |
| Search and retained human work | [Ask: lexical records/original passages; existing tasks](relationships-and-controls.md#records-and-human-work) | Plain search only, no generated answer/index. Existing tasks remain readable/completable, not answer-derived creation. |
| Gmail and evidence | [Business capture, originals, extraction, commitments/decisions, coverage and recovery](relationships-and-controls.md#gmail-evidence-and-privacy) | Current approved new-original scope only. Empty bodies are not originals; no history import or live usefulness claim. |
| Privacy and corrections | [Source/access/retention, correction/deletion closure](relationships-and-controls.md#gmail-evidence-and-privacy) | Domain/API controls and retained tests. Irrecoverable live deletion needs approval; not a demo step. |
| Meetings and notes | [Existing meeting preparation, notes, recordings and follow-through](relationships-and-controls.md#meetings-and-recordings) | Retained functionality, local synthetic persistence evidence. Booking/recording authority and actual usefulness remain separate. |
| Access, settings and diagnostics | [Normal sign-in, devices, owner setup, holds/caps, appearance](relationships-and-controls.md#access-and-owner-controls) | Browser Settings is account/access/appearance only. Desktop owner controls remain. No auth bypass or consent inferred from health. |
| Release, recovery and installation | [Hosted execution](../operations/lean-release-workflow.md), [invariants](../greenfield/release.md), [desktop install](../greenfield/install.md) | Operational path, not a user feature proof or activation permission. Restore UNTESTED unless explicitly evidenced. |

Browser shell/navigation source: [BrowserApp](../../apps/web/src/client/BrowserApp.tsx), [sections](../../apps/web/src/client/workspaceNavigation.ts). Secondary destinations are linked where actually supported, not invented new routes. API/worker composition: [processes](../greenfield/processes.md). Desktop fallback composition: [App](../../apps/desktop/src/renderer/app/App.tsx).

## Drive and interpret

[Verification guide](verification.md) owns setup/navigation/check selection and maps Root's retained observed bounded navigation/request/current-read path. No next acquisition or replay is authorized. Journey pages link source and existing checks. Other recipes not exercised by this documentation lane are explicitly **draft/unrun**. Retained observations stay labeled retained; a screenshot proves visible state, not a database/provider effect.

## Distinct authorities

- Intended behavior: applicable [issues/spec tickets](../agents/issue-tracker.md), [glossary](../../GLOSSARY.md), [ADRs](../adr/) and approved direction. No new SPEC naming rule.
- Remaining work/finite owners: [PLAN](../../apps/web/PLAN.md), tied to GitHub issues. Priorities: [roadmap](../sourcing/roadmap-20261007.md).
- Dated production/main/schema/activation and receipt location: [current-state](../operations/current-state.md). Private receipts are not copied into this map.
- Actual implementation/observation: linked source, harness and retained execution evidence. Prose, imports and test names alone establish no observed effect.

Update affected journey/drive links with feature changes. One combined ordinary correctness/simplicity review checks map impact; actual-risk specialists, enforced workflow ratchet and in-flight reviews remain. Reuse evidence while relevant code/configuration/environment assumptions hold. Changed behavior/harness/setup needs relevant verification, not another full-product campaign. A slice does not silently narrow full scope or block unrelated ready delivery.
