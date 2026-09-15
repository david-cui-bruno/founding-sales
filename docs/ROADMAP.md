# FSS delivery roadmap

Updated 2026-09-15 (delivery status as of 20:51 UTC). This is the active product roadmap. Older design documents are historical context, not a required Superpowers execution process.

## The outcome

A founder should arrive at a useful queue of calls, messages worth reviewing, and meetings. Research, contact preparation, approved follow-ups, and scheduling should reduce founder homework. A large backend and a green test count do not by themselves deliver that outcome.

## Local capabilities and their limits

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

These local capabilities and regression results do not all describe the installed build. The installed checkpoint and the newer merged/open work are distinguished below. A merge alone does not update the installed app.

## Delivered checkpoint: September 15

- **Installed:** build `2364218`, ASAR hash prefix `08d21a2d`, following a backed-up, separately approved installation. This supersedes the old September 12 candidate-not-installed checkpoint.
- **Observed in the installed app:** one explicitly authorized Lenox company-research run at 18:40 UTC saved four facts. Research was then paused, and the saved result remained after restart. This is evidence for that selected research and retention path, not automatic discovery, a useful generated draft, a send, or useful daily automation.
- **Merged:** [PR 42, company-only draft backend](https://github.com/david-cui-bruno/founding-sales/pull/42) and [PR 43, saved reply conversation/history](https://github.com/david-cui-bruno/founding-sales/pull/43). Backend availability and saved conversation history do not establish an installed composer or live mailbox acceptance.
- **Merged at 20:49 UTC:** [PR 44, daily owner-read performance](https://github.com/david-cui-bruno/founding-sales/pull/44), merge checkpoint `d55f420`. The local regression demonstrates fewer repeated pending-command scans while preserving outputs. It is not an installed latency measurement.

### Open outcome PRs, not installed acceptance

| PR | Candidate checkpoint | Scope and honest limit |
| --- | --- | --- |
| [45: company draft composer](https://github.com/david-cui-bruno/founding-sales/pull/45) | `68215e1` | Company-only unsent draft review/edit/reopen UI. Open. A useful real-company draft still needs product acceptance. |
| [46: ordinary reply backend](https://github.com/david-cui-bruno/founding-sales/pull/46) | `db870cb` | Saved ordinary-reply editing backend. Open. No live mailbox or send acceptance follows. |
| [47: company phone UI](https://github.com/david-cui-bruno/founding-sales/pull/47) | `2543a32` | Explicit company-phone review/handoff, durable history and human-reported outcomes. Open. Setup, policy and separate real-call authorization still apply. |
| [48: ordinary reply editor](https://github.com/david-cui-bruno/founding-sales/pull/48) | `14df51c` | Saved reply editing UI. Open and depends on PR 46. Editing is not sending or live mailbox qualification. |

The combined 44-path local candidate passed 9,282 tests with one existing skip, plus types and lint. These results support integration of the local changes. They do not establish installed acceptance, live research/draft quality, a physical phone path, email delivery, calendar operation or useful automatic queue generation. The installed checkpoint remains `2364218` until a separately approved update.

## What still matters next

| Priority | Outcome | Remaining work / honest limit |
| --- | --- | --- |
| 1 | Complete one useful real-company UNSENT draft journey | On a separately approved candidate with the needed draft UI, use one explicitly approved property-management company and its supported route or saved contact. Review relevant research, create a useful unsent draft, edit it, navigate away and reopen it. Preserve company-only work without inventing a person. Record usefulness, elapsed time, unnecessary clicks and confusing holds. The installed research/retention checkpoint is a start, not completion of this milestone. |
| 2 | Qualify one small manual-call campaign | Separately configure and verify real worker ownership and phone setup. Save, explicitly approve and separately enroll the supported template, confirm the intended Today item, then separately authorize the actual phone handoff. Enrollment alone does not place a call. Qualify this path before expanding campaigns. |
| 3 | Remove founder preparation homework | Saved research feeds the existing automatic draft, but research/import/reviewed-link steps still require founder effort. Use the real walkthrough to choose which preparation steps should become automatic and which genuinely need review. Measure relevance and time saved. A useful automatic daily queue remains the biggest product gap. |
| 4 | Prove ongoing live operation | With separate authorization, qualify scoped mailbox/calendar access, permitted email follow-ups, reply stops, scheduling and meeting briefs, including worker operation while the Mac sleeps. Start with a tiny approved cohort. Local pairing and synthetic tests do not establish these outcomes. |
| 5 | Improve observed use before expanding | Fix friction, performance and recovery issues actually seen in the walkthrough. Consider broader sequences and manual-final-send LinkedIn support only after the small path is useful. Prefer measured user impact to generalized infrastructure. |

The next milestone is complete when one approved real-company journey produces a useful UNSENT draft that survives edit/reopen in the approved installed candidate, using relevant saved research. The backed-up installation and one selected research run are already recorded checkpoints, not proof that this draft milestone is complete. Any newer installation still needs separate approval, a verified profile/prior-app backup and a preservation check. Do not launch a scratch candidate against the real profile first. Record the remaining manual work. Do not count installation alone, a green test suite or an enrollment receipt as proof of an operational sales system. A useful automatic queue and live mailbox/calendar operation remain unaccepted outcomes.

## Where we overbuilt

We spent too much time repeatedly freezing files, hashing evidence, expanding negative-test matrices, and commissioning reviews for tiny changes. Some of that caught real safety defects. Repeating it for every fixture or label correction delayed the usable product, left a large unpublished branch, and made progress hard to understand.

The backend is ahead of the user journey. Historical repair-task completion is not a percentage of whole-product readiness. More tests are not a substitute for proving the next useful workflow.

## Working rules now

1. Ship small PRs organized around one user-visible outcome. The initial historical PRs are intentionally larger because they preserve the accumulated history.
2. Review actual risks, run affected tests and one combined candidate gate, and merge good changes. Preserve strict gates without adding a new ceremony for every edit.
3. Keep a short, explicit product acceptance path and fix failures directly. Do not invent new infrastructure to avoid using the product.
4. Retain honest unavailable/unknown states. Do not hide missing live setup behind fixture success or a preview screen.
5. Publishing and merging code are authorized. Installation, deployment, real-profile migration, new grants, live pairing, calls, sends, invites, purchases, and private-data exports remain separate decisions.
