# FSS delivery roadmap

Updated 2026-09-13. This is the active product roadmap. Older design documents are historical context, not a required Superpowers execution process.

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

## Delivered checkpoint

- Product delivery through [PR 15](https://github.com/david-cui-bruno/founding-sales/pull/15) is merged in the public repository. The September 12 checkpoint is `48e0ab1`; its [postmerge main check](https://github.com/david-cui-bruno/founding-sales/actions/runs/34705288424) passed. Later documentation-only changes do not change that product checkpoint.
- The signed candidate built from `4044245` contains the research-grounded draft, manual-call campaign saving, separate approval and enrollment. Product code is unchanged from that candidate. PR 15 corrected only an external Friday test fixture, and all 31 maintained signed-app workflows passed against the same candidate with the corrected test.
- The candidate is **not installed**. Its qualification does not establish a positive packaged campaign journey, real-profile acceptance, live research/model quality, a working phone handoff or useful daily automation.

## What still matters next

| Priority | Outcome | Remaining work / honest limit |
| --- | --- | --- |
| 1 | Put the qualified candidate in front of the founder | With separate installation approval, normally quit the old app, take and verify a fresh profile/prior-app backup, install the exact signed candidate and confirm preserved data. Do not launch a scratch candidate against the real profile first. |
| 2 | Complete one useful real-company journey | Use an explicitly approved property-management company and contact. With any required provider authorization, review relevant research, create a useful unsent draft, edit it, navigate away and reopen it. Record elapsed time, unnecessary clicks and confusing holds. This is the next product acceptance milestone, not another infrastructure project. |
| 3 | Qualify one small manual-call campaign | Separately configure and verify real worker ownership and phone setup. Save, explicitly approve and separately enroll the supported template, confirm the intended Today item, then separately authorize the actual phone handoff. Enrollment alone does not place a call. Qualify this path before expanding campaigns. |
| 4 | Remove founder preparation homework | Saved research feeds the existing automatic draft, but research/import/reviewed-link steps still require founder effort. Use the real walkthrough to choose which preparation steps should become automatic and which genuinely need review. Measure relevance and time saved. A useful automatic daily queue remains the biggest product gap. |
| 5 | Prove ongoing live operation | With separate authorization, qualify scoped mailbox/calendar access, permitted email follow-ups, reply stops, scheduling and meeting briefs, including worker operation while the Mac sleeps. Start with a tiny approved cohort. Local pairing and synthetic tests do not establish these outcomes. |
| 6 | Improve observed use before expanding | Fix friction, performance and recovery issues actually seen in the walkthrough. Consider broader sequences and manual-final-send LinkedIn support only after the small path is useful. Prefer measured user impact to generalized infrastructure. |

The next milestone is complete when the backed-up installation preserves existing data and one approved real-company journey produces relevant research and a useful unsent draft that survives edit/reopen. Record the remaining manual work. Do not count installation alone, a green test suite or an enrollment receipt as proof of an operational sales system.

## Where we overbuilt

We spent too much time repeatedly freezing files, hashing evidence, expanding negative-test matrices, and commissioning reviews for tiny changes. Some of that caught real safety defects. Repeating it for every fixture or label correction delayed the usable product, left a large unpublished branch, and made progress hard to understand.

The backend is ahead of the user journey. Historical repair-task completion is not a percentage of whole-product readiness. More tests are not a substitute for proving the next useful workflow.

## Working rules now

1. Ship small PRs organized around one user-visible outcome. The initial historical PRs are intentionally larger because they preserve the accumulated history.
2. Review actual risks, run affected tests and one combined candidate gate, and merge good changes. Preserve strict gates without adding a new ceremony for every edit.
3. Keep a short, explicit product acceptance path and fix failures directly. Do not invent new infrastructure to avoid using the product.
4. Retain honest unavailable/unknown states. Do not hide missing live setup behind fixture success or a preview screen.
5. Publishing and merging code are authorized. Installation, deployment, real-profile migration, new grants, live pairing, calls, sends, invites, purchases, and private-data exports remain separate decisions.
