# FSS delivery roadmap

Updated 2026-09-11. This is the active product roadmap. Older design documents are historical context, not a required Superpowers execution process.

## The outcome

A founder should arrive at a useful queue of calls, messages worth reviewing, and meetings. Research, contact preparation, approved follow-ups, and scheduling should reduce founder homework. A large backend and a green test count do not by themselves deliver that outcome.

## What the current local candidate can do

- Use one coherent Mac workspace across Today, Accounts, saved contacts, Import, and Settings.
- Preserve local work, selected records, and in-progress edits across navigation and temporary readiness failures.
- Create and reopen a company, run explicitly selected company research, inspect attributed source evidence, import a named person, and review the link to that saved identity.
- Open the exact saved contact, edit and save an unsent email draft, and reopen its persisted contents. Send stays held when setup or exact draft authority is unavailable.
- When a model is configured, the existing first-draft flow includes admitted company facts for one unambiguous current saved-person link. Conflicting claims, hypotheses, personal-role claims, and raw source excerpts are excluded. Source references travel in the model context, not a new persisted draft-citation record. Reopening an edited draft does not regenerate it.
- Expose guarded Phone and Worker connection settings. Pairing is not worker activation, a phone configuration is not a completed call, and company evidence is not verified contact authority.
- Edit local call capacity with revision checks. Unconfigured and zero are different values, and retained obligations are not silently discarded to satisfy a limit.
- Separate saved draft continuations from saved reply history. Unknown or older campaign templates remain read-only. Only the recognized one-company manual-call template exposes reviewed approval and separate enrollment.
- With an active, configured worker and a worker-owned company, save one unapproved call campaign draft: an explicitly selected company, a meeting offer, one initial manual-call step, and lifetime caps of one call and zero email/LinkedIn steps. Saving requires current owner state and exact owner-applied projection. A pending draft keeps the same command identity through an explicit retry or queued-command reconciliation. This does not approve, enroll, activate, or start outreach.
- Review that exact saved manual-call template, explicitly approve it, then separately select a current published or confirmed business-phone route and enroll the company. Enrollment creates a due manual-call item, not a call or contact permission. Both actions recheck current owner state, preserve uncertain command identity, and require exact owner projections before showing success. Other campaign templates and multi-channel activation remain unavailable.

The integrated first-use regression uses the real App, preload/IPC, domain, and an encrypted disposable database. Its research pages, OS services, identities, and model responses are fictional. It validates both manual drafting and automatic generation through the real provider adapter, including company-context attribution and preservation of edited drafts. It does not establish live research/model quality, durable per-draft citations, email delivery, a process crash, or a packaged first-use journey.

The campaign-draft regression separately uses the real Campaigns route, delegation runtime, authenticated worker handler and local encrypted SQL projector, with the existing synthetic DynamoDB harness and fictional accounts. It covers owner-applied saving, separate approval with no enrollment, explicit enrollment into the real Today due queue, a fresh database connection, and same-command draft/enrollment reconciliation after route closure. It asserts zero manual phone handoffs and zero reserved/sent channel counts. It is not a deployed-worker, full preload, process-restart, phone or provider test. Renderer browser checks cover the draft form, retained input, separate review and route-selection controls, keyboard focus and theme/viewport accessibility. They use explicit saved projections, not a second simulated worker-command path.

These new changes are not installed merely because their PRs merge. The installed app remains the previously approved cleanup build until a separate installation decision.

## What still matters next

| Priority | Outcome | Remaining work / honest limit |
| --- | --- | --- |
| 1 | Deliver a coherent candidate | The first twelve PRs are merged. Main `6bb305e` passed hosted checks for campaign drafting. The signed `5dd96d5` candidate passed 31 packaged workflows and does not include subsequent campaign-draft or enrollment changes. Installation and one real-company walkthrough still require a separate backed-up installation decision. Subsequent PRs need their own affected checks, not reruns of every historical checkpoint. |
| 2 | Remove founder preparation homework | Saved company research now feeds the existing automatic draft. The explicit research/import/reviewed-link steps still require founder effort. Measure relevance with an approved real workflow before adding more automation. This is not yet an automatically prepared daily queue. |
| 3 | Make small campaigns usable | The bounded unapproved call-draft path uses the existing versioned owner-command backend, with a readable exact company audience and offer. This branch adds separate reviewed approval and manual-call enrollment for that exact template. Real worker setup/ownership, an installed walkthrough and phone handoff qualification remain prerequisites for use. This is not a whole-sequence activation path. Qualify the small path before adding multi-step/email/LinkedIn campaign editing. |
| 4 | Prove live operation, separately authorized | Configure and qualify the real worker, scoped mailbox/calendar access, phone handoff, delivery/reply stops, and meeting flow. Test a tiny explicitly approved cohort before expanding. Local pairing and synthetic tests do not establish these outcomes. |
| 5 | Improve observed daily use | Fix friction, performance, and recovery issues seen in the actual walkthrough. Prefer measured user impact to additional generalized infrastructure. |

## Where we overbuilt

We spent too much time repeatedly freezing files, hashing evidence, expanding negative-test matrices, and commissioning reviews for tiny changes. Some of that caught real safety defects. Repeating it for every fixture or label correction delayed the usable product, left a large unpublished branch, and made progress hard to understand.

The backend is ahead of the user journey. Historical repair-task completion is not a percentage of whole-product readiness. More tests are not a substitute for proving the next useful workflow.

## Working rules now

1. Ship small PRs organized around one user-visible outcome. The initial historical PRs are intentionally larger because they preserve the accumulated history.
2. Review actual risks, run affected tests and one combined candidate gate, and merge good changes. Preserve strict gates without adding a new ceremony for every edit.
3. Keep a short, explicit product acceptance path and fix failures directly. Do not invent new infrastructure to avoid using the product.
4. Retain honest unavailable/unknown states. Do not hide missing live setup behind fixture success or a preview screen.
5. Publishing and merging code are authorized. Installation, deployment, real-profile migration, new grants, live pairing, calls, sends, invites, purchases, and private-data exports remain separate decisions.
