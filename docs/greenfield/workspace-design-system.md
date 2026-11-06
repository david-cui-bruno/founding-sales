# Callie workspace design system

Approved direction: David's November 5, 2026 review, [#939](https://github.com/david-cui-bruno/founding-sales/issues/939). Design handoff merged in PR940; production cutover is still pending. This is the reusable design contract, not a claim that the prototype's simulated operations exist in production. [Delivery roadmap](workspace-redesign-roadmap.md) owns sequence and acceptance; [journeys](../features/README.md) own actual product coverage.

## Authority and reference

Use this document for patterns and constraints; use the [preserved prototype](workspace-prototype/index.html) for composition, density and visual comparison. It supersedes the earlier 73-view inventory and pearlescent/glass presentation, not existing domain, privacy or sending rules. Main model owns design and integration; do not divide visual design among independent agents. Ordinary review and actual-risk reviews remain required.

Run the static reference with `python3 -m http.server 8878 --bind 127.0.0.1 --directory docs/greenfield/workspace-prototype`, then open `http://127.0.0.1:8878/`. Its datasets, timers, delivery statuses, prices, addresses and statistics are fictional. It has no application connections. Feedback is local to that browser. The prominent reference notice identifies simulations; no copied demo handlers belong in production.

## Information architecture

| Destination | Job | Working pattern |
| --- | --- | --- |
| Today | Decide what needs attention next | Ordered work queue and actionable detail; completion advances deliberately |
| Prospects | Research, call, record what happened | Company list plus brief; call and wrap-up replace each other in place |
| Pipeline | Advance commercial opportunities | Stage columns; exact deal drawer, values, next action and activity |
| Email | Reply, fulfil promises, inspect outreach | Replies, Drafts, Campaign; list plus thread/editor/detail |
| Social | Maintain the approved publishing rhythm | Schedule and post preview, Drafts, Library, Conversations |
| Settings | Configure and troubleshoot | Account, Calling, Connections, Booking, Appearance, Pipeline, Diagnostics |

Settings is secondary; Sign in is outside the workspace. Search and existing tasks/relationship/meeting controls remain reachable in context, not orphaned by fewer sidebar entries. One Firm may have several Opportunities; board cards identify the Opportunity and display its Firm. Research observations do not silently become Firms, Contacts or eligible routes.

## Visual tokens

System font stack; no downloaded font. Neutral, flat surfaces; restrained borders; calm green for primary actions. Dark mode uses the same semantic roles. These are approved reference values, not a mandate to copy inaccessible contrast unchanged.

| Role | Light | Dark |
| --- | --- | --- |
| Canvas / panel / sidebar | `#fafaf9` / `#ffffff` / `#f3f3f1` | `#111212` / `#17181a` / `#131415` |
| Hover / selection | `#eeeeeb` / `#e8edeb` | `#1e1f21` / `#222728` |
| Border / subtle border | `#e5e4e0` / `#efeeea` | `#2a2c2e` / `#212325` |
| Text / secondary / metadata | `#1a1a18` / `#5b5a56` / `#72716d` | `#ecece9` / `#a4a39f` / `#96958f` |
| Primary / on-primary / soft | `#2d6a4f` / `#ffffff` / `#e5efe9` | `#5fb38a` / `#0c1912` / `#18291f` |
| Warning / soft | `#95580a` / `#f9efdd` | `#e3a95b` / `#2a2116` |
| Error / soft | `#b3261e` / `#fbe9e7` | `#f0867d` / `#2c1a19` |
| Info / soft | `#2856c9` / `#e8eefb` | `#88a9f5` / `#1a2132` |
| Writing / soft | `#6a4fb8` / `#efebf9` | `#b5a3ee` / `#221e32` |
| Control boundary | `#8b8b85` | `#777973` |

Typography: body 14px/1.5; secondary 13px; nonessential metadata 12–12.5px; list headings 17px/650; selected-item title 22px/650. Numeric times, money and counts use tabular numerals. Primary actions use weight 550–600. Tight headings, not oversized dashboard slogans.

Spacing scale: 4, 8, 12, 16, 20, 24, 28, 36px; retain prototype optical adjustments where useful. Button radius 8px; cards 12px; drawer/important work panels 14px; status chips pill-shaped. Regular buttons roughly 34px high, primary call action roughly 42px; icon-only controls need names and adequate hit areas.

Desktop geometry: sidebar 220px; queue 290–350px, narrowing to 270–310px on laptops; detail reading width up to 740px with 28px/36px padding. Board fills remaining width, with readable columns and contained horizontal scrolling when needed. Drawer up to 700px. Do not crush card content merely to fit every column. Desktop-first: verify 1440 and 1024px; 390px must remain usable without page-wide overflow, but no separate mobile redesign milestone.

## Reusable patterns, not a new framework

Implement semantic CSS tokens and a small React pattern set inside the existing web app: workspace shell; work list/detail; primary/secondary/destructive buttons; visible choice groups; labeled fields; status badge; source passage; activity list; deal card/column; drawer; notice; toast; empty/loading/error state. Introduce a reusable module when multiple real consumers need it. Do not build a universal schema-driven form engine, parallel data layer or second design library.

- One primary next action per working state. Essential choices are visible buttons, radio groups or searchable lists. No native `<details>/<summary>` stacks, tiny-triangle disclosures or `<select>` controls. Long choice sets use an explicit searchable chooser, not dozens of chips.
- Prefer in-place work. Brief, Sources and Activity are contextual views, not extra sidebar destinations. A drawer retains the board's position and selected deal.
- Configuration is secondary to daily work. Put calling setup and audio tests in Settings, not above every brief. Exact source passages remain accessible beside claims; deep extraction/receipt metadata belongs in Diagnostics.
- Keep actionable refusals, recording disclosure, recipient identity, unsubscribe/suppression and uncertain outcomes visible at the relevant action. Moving diagnostics must not hide safety information. One workspace banner for global problems; field/action errors stay next to the control.
- Forms have explicit Save/Cancel unless an existing interaction has a reviewed safe autosave contract. Deal value editing shows currency, monthly units and estimate/confirmed meaning; no save-on-blur money writes by default.
- Stage movement records only a commercial decision. It does not book a meeting, start billing, change outreach mode or prove a customer is live. Preserve human stage control and exact Opportunity selection (ADR0005).
- Dragging has a keyboard/click alternative. Undo is a new version-checked compensating change; it cannot erase audit history or retract sent mail. Lost asks for a reason. Historical/stale updates refuse clearly.
- Today nudges after more than five days without a stage move, excluding Live/Lost. This is a chosen heuristic, not a conversion claim. Opening a draft does not complete a promise or establish consent. Keep future meetings distinct from work due today and honor known local zones.
- Edits invalidate email review. Final review shows the actual sender, recipients, subject and exact body. Suggestions never send automatically. Display requested, pending, confirmed sent, refused and unknown distinctly; no success timer or blind resend. Never derive recipients from names/domains as the prototype does.
- Do not block navigation by silently discarding work. Active call and unresolved write custody survive presentation changes under existing owners. Confirm unsaved-text loss; keep private text out of URLs, telemetry and browser persistence unless a specific approved persistence contract permits it.

## Accessibility and states

Use semantic buttons, headings and labeled inputs; real tab semantics or ordinary navigation, not decorative ARIA. Focus visible, logical keyboard order, Escape and focus return for drawers, focus containment for modal work. Announce confirmed changes and relevant pending/error state without noisy timers. Color is never the only status cue. Verify WCAG AA contrast for text and controls; adjust muted tokens where necessary without changing the hierarchy.

Every pattern handles loading, empty, unavailable, forbidden, stale, unsaved, pending, confirmed, refused and unknown where applicable. Counts must reflect their named scope; a loaded page is not total inventory. No source becomes an empty-success response. No hover-only essential action; no dead-end empty state.

## Enforcement during implementation

The production token CSS and real shared patterns are executable truth; this document explains decisions. The development-only pattern gallery renders those actual modules and states, not screenshots or a separate app. No Storybook service, paid dependency or design-system platform is needed.

Executable patterns: [tokens](../../apps/web/src/client/workspaceTokens.css), [shell](../../apps/web/src/client/WorkspaceShell.tsx), [list/detail and states](../../apps/web/src/client/WorkspacePatterns.tsx). On Node24 run `npm run dev:patterns --workspace apps/web`, then open `http://127.0.0.1:8879/`. It watches those same modules with no product connections and reloads after changed successful output. A failed rebuild preserves the displayed and served last-good assets; process-unique build markers also detect server restarts. Stop with Ctrl-C. Metadata and control-boundary colors above incorporate contrast corrections to the fictional reference.

During edits, `npm run dev:test --workspace apps/web -- test/client/workspaceShell787.test.tsx` watches one relevant test file; choose the file matching the changed behavior. `npm run dev:types --workspace apps/web` checks all web source, tests and scripts incrementally. `npm run lint:cached` uses content-based caching. Per-worktree buildinfo/lint caches live under ignored `node_modules/.cache`; cold typecheck/lint and broad acceptance remain final gates, not replaced by these shortcuts.

Actual Node24/Chrome acceptance exercised CSS and TSX auto-reload, last-good preservation after a syntax error, recovery, and offline-edit/server-restart recovery at equal generation1 with distinct process IDs. Temporary source changes were restored exactly. Type watch caught a deliberate TS2322 and returned to zero errors after probe removal; focused watch reran21 tests successfully in1.48s. Observed cached lint was3.41s after a17.71s cold cache run, not a controlled benchmark or guaranteed speedup. The gallery has no sign-in, saving, calling or sending; use the finite signed fixture for real authorization and persistence checks.

For each vertical slice: compare the real browser to the reference at desktop/laptop widths; exercise the changed workflow and refusal/uncertainty paths; retain targeted regressions for meaningful behavior; run workflow/type/lint/secret gates as applicable. Delete replaced CSS, views and incidental wording tests in the same cutover. Do not deliver a new shell whose destinations are placeholders, or claim prototype tests prove backend effects.
