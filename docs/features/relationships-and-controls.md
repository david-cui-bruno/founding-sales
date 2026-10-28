# Relationships, evidence and owner controls

[Map index](README.md) · [Verification](verification.md). These retained groups remain in full product scope alongside the five primary browser screens. Browser coverage is explicitly partial. The following navigation is **draft/unrun by this documentation lane**; existing behavior/test references are retained, not new acceptance or live permission.

## Records and human work

**Goal/reach:** inspect the exact Firm, its people/endpoints/routes and opportunities, then advance the selling journey. Web **Today → Open firm** exposes current selected context. A complete web record/relationship workflow remains a product gap; do not route users through desktop or infer a canonical Firm from a raw prospect. Use [CRM behavior](../greenfield/crm-surface.md).

**Owners/harness:** [CRM/Ask module map](../agents/crm-ask-modules.md), [web Today](../../apps/web/src/client/BrowserToday.tsx), existing [API tests](../../apps/api/test/) and [workspace test setup](../greenfield/workspace.md). Plain Ask retains lexical backend search; generated answers and arbitrary private-data inference remain removed.

## Gmail, evidence and privacy

**Goal/reach:** capture permitted new business conversation originals, extract supported claims/commitments/decisions, inspect coverage and correct errors. Web **Email → Replies** exposes supported retained reply originals. Capture/extraction owner setup remains a web gap; existing backend consent/configuration owners stay authoritative. Read [CRM](../greenfield/crm.md), [mail](../greenfield/mail.md), [classification](../greenfield/classification.md) and [retention](../greenfield/retention.md).

**Owners/harness:** [CRM/Ask map](../agents/crm-ask-modules.md) links source ownership for capture/original read, history/recovery, processing/evidence/decisions/commitments, plain search and deletion. [API](../../apps/api/src/bootstrap/main.ts) and [worker](../../apps/worker/src/bootstrap/main.ts) determine actual mounted/registered behavior. Browser [reply brief](../../apps/web/test/e2e/replyBrief.spec.ts), [custody](../../apps/web/test/e2e/replyCustody.spec.ts), [retained authority](../../apps/web/test/e2e/retainedAuthority.spec.ts) and [recovery](../../apps/web/test/e2e/retainedRecovery.spec.ts) reuse signed auth/disposable PostgreSQL and controlled ports.

**Observable effect:** captured source identity/version and actual readable original precede derived interpretation. A metadata row/empty body is not an original. Derived claims/commitments need grounded evidence and explicit unknown/correction state. After permitted source retirement/access loss, current reads/search/derived views and workers must no longer expose unavailable content, including after lock waits. Test deletion only in disposable fixtures; irrecoverable production CRM/Gmail/conversation deletion requires owner approval.

**Limits:** incoming+Sent business-only new originals, no history, approved Haiku4.5/$1day/$20month scope remains. No reconnect/backfill/import or extra model export merely to make a map pass. Source version/permission/generation, cancellation, unknown dispatched attempts, budgets and retention refuse stale work. Current capture copied empty bodies, so real-original usefulness remains unproven. Local/synthetic replies are not measured business quality. Legacy Answer/Embedding setup does not reactivate removed adapters.

## Meetings and recordings

**Goal/reach:** browser [Today](../../apps/web/src/client/BrowserToday.tsx) → exact Firm **Open firm** → **Meeting preparation** or **Meeting notes**, with current assigned-or-admin access. In [preparation](../../apps/web/src/client/BrowserMeetingPreparation.tsx), choose **Load existing meetings**, then an exact meeting and **Open preparation**. In [notes](../../apps/web/src/client/BrowserMeetingNotes.tsx), enter the existing meeting UUID and choose **Read meeting notes**; switching from preparation does not select it automatically. This source-supported path is not a standalone Meetings destination or fresh hosted acceptance. Meeting notes have a [web editor](../../apps/web/src/client/MeetingDebrief.tsx); recording administration remains a web gap. [Meetings behavior](../greenfield/meetings.md) describes the domain.

**Refusal/recovery:** unavailable preparation, missing meeting selection or denied Firm access is a specific read/access boundary, not proof the entire feature is absent. Recheck the selected Firm, current access and exact existing meeting before a permitted read. Preserve uncertain note-command custody; do not resubmit or invent a meeting to bypass refusal.

**Harness/observable:** [existing synthetic instructions](../../apps/web/scripts/localdemo.md), [synthetic browser test](../../apps/web/test/e2e/syntheticBrowser781.spec.ts) and [initial local browser acceptance](../../apps/web/test/e2e/localBrowser.spec.ts) cover signed access and actual notes persistence. Save an explicitly fictional note, then reopen the same meeting UUID/revision after reload and check the stored note, not just a success label. The existing fixture contains an invented agreed time, not a real calendar booking.

**Limits:** retained preparation/notes/transcription/follow-through source is not booking, actual media upload/transcription or live inference evidence. Cal.com remains disconnected. Recording and microphone/data/provider authority are independent. Existing proposed work is not a confirmed human commitment. Do not launch real recording or scheduling to test the map.

## Access and owner controls

**Reach:** existing workspace's normal sign-in, then **Settings & account** for browser appearance/current workspace/role/expiry and **Refresh access**. **Sign out** is in the sidebar. [BrowserSettings](../../apps/web/src/client/BrowserSettings.tsx) explicitly does not configure capture/calling/channels. Appearance is page-local, not a saved preference. Device/mailbox/channel administration must be built as bounded web journeys around the existing backend owners. See [settings](../greenfield/settings.md), [identity](../greenfield/identity.md), [sending](../greenfield/sending.md) and [suppression](../greenfield/suppression.md).

**Owners/harness:** [ADR0012](../adr/0012-browser-session-boundary.md), [browser server](../../apps/web/src/server/browser.ts), [BrowserClient](../../apps/web/src/client/BrowserClient.ts), [thin host](../../apps/web/test/e2e/thinHost.spec.ts), [founder host](../../apps/web/test/e2e/founderHost.spec.ts), [glass workspace](../../apps/web/test/e2e/glassWorkspace.spec.ts) and [web settings](../../apps/web/src/client/BrowserSettings.tsx).

**Observe/refuse:** real signed session/API access, not an injected principal. Logout/revocation/expiry/role/source changes clear private view/custody and late responses cannot restore it. CSRF/origin/session mismatch refuses. Remote logout uncertainty must remain visible. Never inspect codes/cookies/tokens, bypass auth or reset credentials to make navigation pass. Normal2FA belongs to David.

Owner changes require exact current readback/audit, not process-health flags. Stored owner OFF survives healthy releases, newer holds and cap/ramp/eligibility checks remain. Device/config availability is not consent or a provider effect. Operations/diagnostics/release/recovery use the sole [hosted entrypoint](../operations/lean-release-workflow.md) and [invariant reference](../greenfield/release.md), never an invented browser control or local production-write recipe.
