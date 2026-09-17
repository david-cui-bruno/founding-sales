# Three compact Today studies

Status: standalone visual comparison. David selected **A · Native Desk** and approved a focused copy cleanup on September 9, 2026. This is not approval to install a replacement app or activate live operations.

Open [`2026-09-09-today-studies.html`](2026-09-09-today-studies.html). The original [layout review](2026-09-09-meeting-first-today.html) is preserved unchanged.

## Compare

- **A · Native Desk:** a tinted queue and inset foreground sheet, low shadow, rounded groups, proportional system sans.
- **B · Structured Index:** an edge-to-edge panel, crisp section bands, aligned label/value rows and minimal elevation.
- **C · Warm Brief:** a paper-like surface, softer depth and a serif opening question. Navigation, editable messages and actions remain proportional sans.

The eight fictional records are byte-identical across the three studies and the original fixture dataset. Each alternative starts at compact density. No photos, downloaded fonts, analytics, external assets or network services are required.

Try **Jamila** for the call brief, **Nora** for the requested-email editor, **Marcus** for manual LinkedIn and **Rosa** for a meeting. Use the A/B/C controls to compare the same selection. Appearance is always available at the top. Preview states includes a quiet day, offline and phone-setup examples.

## Interaction continuity

- A/B/C changes presentation without rebuilding the selected item's DOM. Draft text, text selection and approval/outcome state are retained.
- The chosen study, person, drafts and demo reports survive reload when browser storage is available.
- Arrow Left/Right and Home/End switch studies while focus is within the study controls. Arrow Up/Down moves through the queue, and Enter selects a person.
- Meeting time, status, purpose and the three-point agenda are prioritized. The original source quote remains in **Source, attendees & history**.
- On narrow screens, a selected item replaces the queue. **Back to Today** returns to it in every study.
- Reset demo clears this comparison's example state and restores its default study and appearance. It does not affect the original mockup.

State is local to `callie.today-visual-studies.20260909.v1`. It does not read the real application profile. If local storage is unavailable, an explicit warning explains that edits last only for the current page.

## Selected direction: A with quieter copy

The approval paragraph is now a small **Approved** status. Repeated action-footnotes, the rail slogan and workspace disclaimers are removed. One **Prototype · no live actions** label remains visible at desktop and narrow widths. Preview dialogs and notifications use shorter wording.

This is not blanket shortening: call context, opening questions, evidence, message bodies and meeting agendas are unchanged. New replies, offline access and manual reply/opt-out holds still explain what needs attention. Approval still clears when the draft changes. Copy/open actions still do not mark anything sent or connected.

The three studies share rendering, so this copy pass also appears in B and C. Their layouts and all eight fixture records remain unchanged. The Downloads comparison is refreshed in place without changing the storage key or resetting existing drafts.

Next: use A to review one call, one email and one meeting. Once those flows feel right, propose a bounded Today-screen integration into the real app. Do not treat this design selection as permission for live outreach or account setup.

## Truthful demo boundaries

Calls, clipboard operations, LinkedIn opening, email approvals, calendar opening and rescheduling are simulations. No call, message, invitation, reminder or external navigation is performed. The worker/device statuses are fictional examples, not live connection checks.

A call handoff is not a connected call. Copying or opening a LinkedIn step is not sending. LinkedIn replies and opt-outs are explicitly reported, with retained recaps. Email approval is not delivery, and edits invalidate the demo approval. Stale context and offline states retain text while holding relevant actions. Real product/backend policy remains outside this comparison.

## Verification

Browser checks are retained in [`2026-09-09-today-studies.verify.mjs`](2026-09-09-today-studies.verify.mjs). They use the repository's existing Playwright and Axe dependencies, with all HTTP requests blocked. Run from the repository root:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"
node docs/prototypes/2026-09-09-today-studies.verify.mjs
```

Screenshots and JSON results default to `~/.jcode/scratch/fss-today-variations-20260909/`. Set `FSS_STUDY_RESULTS` to another scratch directory if needed. `FSS_STUDY_TARGET` can point the same checks at an exact copied HTML file.

The regression first failed against the original prototype because the three study controls did not exist. Subsequent real layout checks reproduced and repaired queue clipping, a meeting agenda falling below the first visible pane, a mobile CSS-specificity conflict and insufficient warm wordmark contrast at its smaller mobile size.

The original layout verification passed 23 browser workflow groups and 40 Axe scans with no critical or serious violations. Independent review identified a taller-to-shorter-to-taller scroll-offset loss, reproduced as 87px instead of 111px on return. The repair retains the intended offset through temporary clamping while allowing new user scrolling to supersede it.

The matrix covers all three studies at 1440×900 and 1050×900 in light and dark mode for calls, email and meetings, plus narrow-screen navigation and all three mobile email views. It checks actual editor identity, caret and state retention, queue keyboard behavior, reloads, approval invalidation, stale/offline holds, manual outcome reports, distinct surface structures, clipping and accessibility. Visual hierarchy was also inspected in rendered screenshots. Automated checks do not decide which aesthetic the user prefers.

The copy-cleanup regression first failed on the old approval paragraph. Screenshot review also caught the compact status below the scrolling editor. A failing viewport hit-test reproduced it, and the status was moved beside the fixed action buttons. The refreshed Downloads copy then passed **24 browser workflow groups and 41 Axe scans**, including approval persistence, edit invalidation, the compact approved state, narrow-screen prototype identification and the shortened preview dialogs. There were no browser script errors, external HTTP requests, or critical/serious Axe findings. Results and screenshots: `~/.jcode/scratch/fss-copy-cleanup-20260909/delivered-final/`.

Current HTML SHA-256: `a92477280c559e9b25ed4b053af13b5df42d6681125ef02e90d1db301f82c4fe`. The original fixture DATA and baseline prototype were checked byte-for-byte against the prior commit. Runtime checks were run by the coordinator in headless Chromium. Other browsers were not separately qualified.

Independent bounded review closed with no findings. The reviewer also exercised escaping, persistence and action holds, then checked the final approval placement across three studies and three viewport sizes. Narrow screens retain normal page scrolling to the action row.

Research rationale and official inspirations: [compact structure research](2026-09-09-today-visual-research.md).
