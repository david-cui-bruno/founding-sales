# Owner Settings

`apps/desktop/src/renderer/settings/SettingsView.tsx` composes the current compact page. It reuses existing bridge/contracts and server authority rather than adding a second configuration system. Actual installed version and deployed capability availability remain separate from source completion.

## Ordinary page

- **Account:** signed-in status, role when known, mailbox and app/update status. Connection does not imply capture or interpretation consent.
- **Calling:** number, compact personal state confirmations, calling switch, daily budget and voicemail. Personal confirmation must be genuine. Server refusals and spending/credential gates remain authoritative.
- **Email:** production sending switch, postal address, domain health and caps/ramp. A displayed deployment flag is not the stored workspace switch or effective sending. Technical release reference/history are under Advanced. A setting draft does not save itself.
- **Research & discovery:** research switch and daily/monthly budgets, shared research steps/day, page bound and read-only discovery status/allowances. A fresh firm normally uses two steps. Research off pauses new discovery/check work; on bypasses neither holds nor allowances. Independent discovery configuration is not exposed in this client.
- **LinkedIn:** account connection only, not authority for outreach or posting.

## One collapsed Advanced section

Keyboard-accessible Advanced retains configuration, Dashboard and Diagnostics views, time zone, stage editor, holidays, reply model, recording/calendar controls, raw history, CRM owner controls and operational status. Some deep links open the containing disclosure without writing a setting. Actual retained dashboard/diagnostic controls must not be confused with deleted orphaned diagnostics.

Email release setup/history live inside Advanced while ordinary switch/address edits remain above. Technical edits remain drafts until the corresponding explicit Save, with unchanged server release-reference validation. See [release invariants](release.md). Cal.com capacity's Settings mount is absent, but its domain/API compatibility and live meeting synchronization remain. Generated Ask, automatic outreach-admission and recurring-posting policy sections are absent.

## Save and refusal boundaries

`useAdmin.ts`, `Administration.tsx`, `SettingRow.tsx`, `CallingCalendarSection.tsx` and specialized existing sections retain their authenticated command paths, stale-version checks, read-only/refusal state and attribution of errors. Waiting/offline/identity changes cannot create authority. Reload after uncertain outcomes rather than submitting a new conflicting command blindly.

Settings → Advanced → CRM owner setup retains capture/extraction configuration with exact model/endpoint, token prices, budgets and access/data-handling versions. Saving extraction configuration is disabled-only and clears current authority; it queues no provider work and grants no capture/backfill/processing/outreach consent. See [owner setup](../operations/crm-capability-activation.md) for separate approval, Disable and deletion boundaries.

Existing component and browser flows protect ordinary/advanced accessibility, private identity changes, refusal and save behavior. Fixture screenshots are fictional rendered source evidence, not production configuration or permission. Do not click a live Save/Enable, switch an account or perform provider work as part of UI verification.
