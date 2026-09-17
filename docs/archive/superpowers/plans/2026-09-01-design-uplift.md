# Design Uplift Plan (from the 2026-09-01 desktop design audit)

Executing the audit's roadmap. Reference bar: Linear density/typography, Attio grid,
HIG-native chrome. All existing gates stay green (cssWiring, axe, packaged E2E).

## Phase 0 — Foundation (sequential, everything depends on it)
- Tokens: OKLCH-tuned neutral ramp mapping (canvas/surface/sunken/line/text*),
  muted status set (success/warning/danger, background+dot only), radius scale
  (6 controls / 8-10 cards / 12 dialogs), type scale 11-24 per audit table.
- Typography: vendored InterVariable (self-hosted woff2), `liga+calt+cv11`,
  `tabular-nums` on all numeric surfaces, 14px base, uppercase labels only for
  true column headers.
- Electron chrome: `titleBarStyle:'hiddenInset'` + `trafficLightPosition`, drag
  region in sidebar header, `cursor:default` global (pointer only for external
  links), window `backgroundColor` synced to theme + `ready-to-show`.
- Per-page header component (title + live count + primary action slot + search
  slot); delete the empty top bar; theme/density controls move to Settings →
  Appearance (E2E founderWorkflow spec updated).
- Shared primitives: styled Select/Menu (dependency-free, palette-style),
  StatusBadge (dot + label), SegmentedControl, display utilities
  (`titleCaseDisplayName`, `humanizeEnumLabel`).

## Phase 1 — Screens (parallel, disjoint scopes)
- **Today**: 44-56px rows, hero reason line, hover/focus-revealed actions,
  Overdue vs "Unreviewed backlog (N)" split with "Review next 10", real
  progress bar, collapsed empty lanes, J/K + Enter, no enum leakage.
- **Leads**: page header count, filter chips with selected state, bulk-action
  floating bar, Title Case names, fixed CONTEXT cell, right-aligned numerics,
  click-to-sort headers (replaces native select), J/K + Enter. Virtualization
  deferred (<1k rows renders fine; noted for later).
- **Pipeline/Conversations/Learnings/Review**: compact cards, collapsed empty
  columns, scroll affordance; single empty state in master-detail; chip
  selected states; segmented control in Review; varied empty-state copy.
- **Settings/Friday**: Settings IA (Appearance / Data & storage / Sourcing /
  Diagnostics with StatusBadge / Shortcuts / About); Friday themed bands
  (Funnel / Revenue / Health), deltas vs last week, "No data yet" instead of
  em-dash, week picker, local time, proper date-time input.

## Deferred (explicitly)
TanStack virtualization (until ~1k+ rows), Pipeline drag-with-confirm, Sonner
toasts, onboarding checklist, motion pass, sparklines (need ≥2 weeks data),
Lucide migration (current icons acceptable; revisit).
