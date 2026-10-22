# Local browser slice, issue #738

Approved October22 2026 at05:39UTC. This is local synthetic-data implementation, not a hosted launch or production data migration. ADR0012 is the shared security boundary. Existing desktop and production129 remain unchanged.

**Local slice CLOSED:** code966c9819f, milestone docs5ff947097. Final10/10 actual local-browser workflows,43 unit/component checks, finished spec/standards/privacy reviews and owned PG/TLS/process cleanup accepted. The ownership table below records completed work, not active builders. Product interview completed October22 at07:10UTC; the following desired scope supersedes earlier preference uncertainty, not runtime controls or implementation status. Issue #738 remains the local-slice tracker and decision handoff, not permission to implement the full roadmap.

## Sequence and exclusive ownership

| Outcome | Owner | Exclusive files | Waits |
| --- | --- | --- | --- |
| Shared platform/session contract | Hatchling | `src/shared/browserContract.ts`, `src/server/runtime.ts`, ADR0012, workspace configuration | Committed7dac0db29/e85ccde08, focused tests/types/workflow passed |
| Browser authentication and selected API gateway | Snake | `src/server/**` except runtime, `test/server/**` | Locked contract only, no UI or PG dependency |
| Browser UI/transport and durable existing action | Squid | `src/client/**`, `test/client/**` | Locked contract, server-owned client version |
| Actual local-browser acceptance | Swan | `test/e2e/**`, `test/support/**`, `playwright.config.ts` | Actual server/UI code for execution, sole disposable-PG lane |
| Integration, checks, finished review and docs | Hatchling | Workspace/lock/config, this plan and normal current docs | Whole implementation and actual acceptance |

One shared isolated worktree starts from exact main881. Owners commit only their own files, never stage another owner's changes or spawn workers. Root handles shared contract changes. Only Swan may run disposable PostgreSQL, maxWorkers1, with explicit teardown and release. Auth/UI focused checks are fake-only and cannot imply browser acceptance.

## Observable acceptance

1. Real local HTTPS browser login -> Today -> existing synthetic Firm -> reload -> logout. Use signed local OIDC through existing API authentication and an isolated real database, no Electron or injected principal.
2. Existing meeting-note read/save on that Firm's synthetic meeting. Preserve exact command identity across reload, duplicate and lost-response handling. Check identity transitions and revocation before dispatch and after response. Discovery creation/link migration is not part of this slice.
3. Finished spec, standards and privacy reviews, normal focused checks and actual Chromium acceptance. Retain any concrete limits instead of calling source completion live selling readiness.

## Local transport

Use an ephemeral synthetic localhost TLS certificate and isolated headless browser profile. Ignore certificate errors only in this local fixture. Server HTTPS, Secure/HttpOnly host cookies, Origin/CSRF, current membership/revocation and command guards are never relaxed for tests. No installed desktop profile, Keychain, real provider or production data is used.

No new hosting, service/account, spend, OAuth registration, production routing, backend relocation, deployment, contact or sending activation is included. Owner OFF, consent, source limits and budgets remain unchanged. The parked native Firm/Today, permitted Gmail-original and useful owner workflow outcomes remain open.

## Settled product direction, not delivered capability

FSS is David's sales cockpit, separate from Callie v2. The customer promise is **time saved on maintenance coordination and chasing tenant/vendor updates**, not generic AI or invented quantified savings. Target nationwide US residential-PM companies: owner/principal first, operations/maintenance leaders second, not individual landlords. Recorded pilot price remains $3/covered door/month, not newly certified legal/live terms.

- **Qualification:** automatically source/research and resolve include/exclude using approved evidence. Retain unresolved cases internally rather than creating a borderline-match chore for David. Never fabricate fit or promote raw observations into qualified contacts. Preserve identity, provenance and channel eligibility as separate facts.
- **Email campaigns:** newly qualified leads should auto-enroll only into an already-approved campaign's targeting/messages/limits. Short AI openings may vary from verified research without reviewing every variation, but approved offer/pricing/promises remain fixed and familiarity cannot be fabricated. This changes desired manual-admission scope in `docs/greenfield/sequences.md`, not current implementation or effective OFF. Reply/refusal/suppression/caps/uncertainty remain authoritative.
- **Review:** only approved email sequences are intended unattended external sending. Replies, one-off messages and LinkedIn/social content remain drafts for David's final look. A later existing runner may perform exact approved work, never blanket unattended LinkedIn DMs/posts or a competing sending engine.
- **Today:** reuse the desktop review-queue format, with items arriving throughout the day, no new morning dashboard or compulsory batch. Clear commitments in confirmed meeting/call notes may create/update follow-up tasks; resulting external messages still need review. Preserve commercial-stage authority under ADR0005.
- **Briefs and CTA:** about one screen of company/person facts, prior interactions, explicitly hypothetical pains, three tailored questions, next step and accessible sources. Cold first touch asks for a short discovery conversation; demo/pilot follows interest. Interested-reply drafts reuse David's existing approved booking link. Public-link availability and live calendar sync are separate; no autonomous scheduling.
- **Editorial:** PM-customer usefulness first. Use approved material, sourced recent real-estate news and frank relevant industry problems, mostly useful commentary with occasional soft CTA. No invented news, wins, quotes, needs, commitments or product capabilities. Proactively draft selective relevant PM-discussion comments for review. A private editable learning-from-edits guide separates durable voice preferences from one-off facts, not external training permission.
- **Style:** Pavan Kumar at Clean, James Hawkins at PostHog and Michael Levin from Drip/now dreach are voice references, not audience templates or conversion forecasts. Ayaan Ghazali remains unidentified, no substitute/style analysis invented.
- **Social reuse:** David reports LinkedIn browser-automation permission is already obtained, do not reopen that debate. Intended modest posting cadence is roughly one/day, still review-first. Reuse Jcode/Dot/another existing runner plus scheduling and a shared CRM approval/activity/unknown-outcome ledger, not a browser platform. LinkedIn sequence planning/drafting is desired, not unattended execution. Facebook personal-profile/business-group feasibility remains research-only; no groups vetted, joining or publication authorized.
- **Models:** prefer capable Gemini using existing Google credits. Eligibility, project/API/billing route and approved data processing must be verified before proposing activation. A small representative task comparison should assess brief/draft quality, without assuming model superiority, running inference or changing providers from this preference alone.

These decisions supersede desired manual-only LinkedIn and email-admission restrictions, while those documents still describe retained implementation. No runtime authorization, limits, owner consent or source restrictions are changed by this plan.

## Outcome order and done means

1. **Qualified leads → useful Firm/Today → approved outreach → actual replies with useful drafts and meeting briefs.** Actual authorized business acceptance is still required. Synthetic local login/notes are closed proof for their scope, not this end-to-end result. Preserve existing Westrom Firm/uncertain link and genuine capture-original gap without replay.
2. **Social posts and comment drafts NEXT**, with final review and reused runner/shared ledger. This is not indefinite deferral.
3. Call coaching parked. Existing demo, calling, capture and native acceptance parents remain visible, not erased or falsely blocked on an unfinished product interview.

## Proposed next slice: thin same-origin host

**Proposal only, waiting on concrete next-slice implementation disposition.** Default recommendation is reuse the existing AWS API/HTTPS footprint: serve bundled React assets and mount the reviewed browser adapter on one canonical origin, keeping existing API/domain/workers/Postgres and per-request auth authoritative. Next.js and Vercel were discussed, neither selected. Framework and hosting are separate choices; do not rebuild the accepted UI or move the backend merely to demonstrate a framework.

Root first locks the host/auth boundary and cost/configuration facts. Then one host/auth owner owns production startup/raw streaming-body limit before parse, static routing, CSP/security headers, TLS/origin configuration and server-only cookie-key custody. One UI owner reuses the existing Today presentation, without server-global session projections. One acceptance owner validates the real target host, with the single disposable-PG lane when needed. Assign exclusive files only after this slice is approved, no builders are queued by this proposal.

Acceptance: the actual host, not the test-only HTTP fixture, serves login → Today → existing isolated Firm → reload → logout and the existing durable note. Check preparse oversize refusal, static/CSP behavior, identity/revocation/CSRF/origin/no-store/generation isolation and exact-UUID uncertain-command custody. Do not rerun the closed slice merely to qualify this proposal. Production callback changes must add a separate browser callback without breaking desktop; key custody, actual capacity/cost and Google registration/private-business routing require concrete disposition before applying changes. No zero-cost/capacity claim, new service or hosting account assumed.

After host acceptance, separately authorize guarded rollout and actual approved business-workflow acceptance in the outcome order above. Preserve desktop fallback and sending OFF. This documentation grant authorizes no feature implementation, inference, provisioning, OAuth change, provider/data-route change, deployment, contact or sending activation.
