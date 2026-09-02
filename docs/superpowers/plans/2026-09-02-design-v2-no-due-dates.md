# Design v2 + No-Due-Dates Rebuild (founder-confirmed 2026-09-02)

Source: the founder's design-rules audit ("Callie — Design rules audit and Today
redesign", delivered 2026-09-02). Confirmed decisions:
- **Due dates die app-wide.** No action carries a time; "overdue" stops existing
  as a concept everywhere (Today, Pipeline cadence display, Friday health cards,
  dock badge). Time-sensitivity survives only as (a) Fresh-inbound ordering and
  (b) founder-chosen `resurface_at` dates (snooze / callback promises).
- **Review → Inbox** rename (route, nav, menu accelerator label, palette).
- **Accent: bluebonnet blue** (deep saturated blue ~#1937E3 family, OKLCH-tuned
  per theme) replacing indigo. Accent grammar per audit 2.4: accent = act-here
  only; machine-data chips become neutral with accent hairline (border, no fill).
- shadcn rejected; optionally adopt Radix/Base-UI *headless* primitives under
  existing tokens where our hand-rolled ones are risky (Select, Dialog, Menu).

## Wave 1 — Design v2 (renderer + tokens only)
1. Bluebonnet ramp light+dark (contrast-verified 4.5:1 for text uses), accent
   grammar split: `--accent*` (interactive) vs `--machine-line` (chip hairline).
   Cloud chips: neutral bg + accent hairline + neutral text.
2. Elevation (audit 2.5): `--shadow-overlay` applied to palette, menus, selects,
   dialogs, toasts; dark adds `--inset-highlight` on lifted panels.
3. Icons: adopt lucide-react (tree-shaken); replace ad-hoc SVGs; nav 16px,
   actions 14px; "Refresh" text link -> refresh icon button w/ aria-label.
4. Loading states (2.6): thin top progress bar primitive; master-detail empty
   states single-sided.
5. Cmd+, opens Settings (menu accelerator + palette entry).
6. Hex-rule extension (Part 1): cssWiring also rejects rgb()/hsl()/oklch()/named
   colors + px font-size/spacing literals in feature CSS; allows color-mix() of
   tokens; tokens.css split primitive/semantic layers explicitly.
7. Motion pass: 150ms hover, 200ms menus, 220-260ms drawer/dialog ease-out,
   press scale(0.97), prefers-reduced-motion gates, no animation on palette.

## Wave 2 — No-due-dates model (migration 0010, domain)
Per audit 4.9:
1. Actions lose due semantics; drop overdue state + `non_discretionary_overdue`
   kind; no action generated on import (unreviewed leads have no next_action).
2. `resurface_at` on sales cycles (snooze + callback); Today excludes future.
3. Founder `note` activity type + call `outcome` fields (no_answer, voicemail,
   spoke, interview_booked, not_interested, opted_out) + optional callback date.
4. `review_position` for triage resume. Amendment events (`marked_in_error`).
5. Queue ordering computed at render: lane rank > priority band > cloud timing >
   last-touch age; capacity cap 40 with computed overflow.
6. Friday "overdue" health card removed/replaced (open cycles w/o next step).
7. Review → Inbox rename everywhere.

## Wave 3 — Today rebuild (audit Part 4)
Header dial meter; Next-up card; collapsible lanes (Onboard now, Fresh inbound,
Due cadence, New P0, P1, Exploration, Later — Overdue and Post-interview gone);
44px rows (name + reason line + one chip + hover Call + context menu); empty-
lanes line; backlog card -> triage mode (R, 1/2/3 keys, progress, resume);
call flow: Enter logs call + navigates LeadFullPage w/ outcome section +
Cmd+Enter next; queue-done state. Keyboard map per 4.8. Tests per 4.10.

## Parallel: enrichment gate (Tracerfy account exists, founder logged in)
Per docs/superpowers/plans/2026-09-01-enrichment-gate.md; needs API key from
founder -> SSM /callie-sourcing/tracerfy-api-key; stub mode until then.

## Explicitly kept (audit Part 3)
Tokens-only enforcement, tabular-nums, dialogs+axe, suppression at render,
zero-badge honesty, muted zero chips, stable signal ids, native menu, rows as
unit, sidebar-only vibrancy, one global inspector, explicit logged transitions.
