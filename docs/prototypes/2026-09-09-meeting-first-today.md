# Today layout review, September 9

**Status: prototype for David's review. The production renderer is unchanged.**

Open [the standalone mockup](2026-09-09-meeting-first-today.html). It has no external dependencies or live connections. The local delivery copy is named `FSS-Today-Layout-Review-20260909.html`.

## Recommended direction

Keep the selected Conversation Desk layout: a short queue on the left and the selected conversation, draft or meeting brief on the right. Calls come first, followed by individual approvals and upcoming meetings. Research, evidence and campaign context are available on demand rather than becoming routine founder homework. The Callie wordmark remains below the window controls.

Standard density is the recommended default. **Preview states** includes a more compact alternative, light/dark/system appearance, a quiet day, offline status and iPhone setup needed. These are variations of the same layout, not competing designs.

## Try the flow

1. Select a call, inspect its brief and preview the handoff. Only an explicit reported outcome changes its demo status.
2. Edit Nora's requested email. Switch items or refresh, then return to the saved text. Approval is not delivery. Preview a newer reply to see the preserved draft held for review.
3. Select Marcus's manual LinkedIn step. Copy/open previews never count as sent.
4. Select either meeting. Calendar creation, attendee response and attendance remain distinct.
5. Open Campaigns to inspect targeting, sequence, example message, limits and stops.

Demo edits and reported outcomes are stored only in browser localStorage. Reset demo clears this prototype's state. The page does not dial, send email, open LinkedIn, access the clipboard, create reminders, change a calendar or configure real accounts. Timing changes are explanatory previews rather than simulated persisted scheduling.

## Validation

Actual local Chromium checks exercise selection and keyboard navigation, draft preservation through refresh/preferences/reload, invalidated approvals, offline and phone-only states, explicit call and LinkedIn outcomes, meeting status, and quiet/mobile layouts. Visual and Axe checks cover calls, email and meetings at 1440 and 1050 pixels in light and dark mode, plus a 390-pixel navigation check. The primary action remains outside the scrolling brief. Network requests are blocked in the harness, and the page's content security policy disallows connections.

Evidence and the runnable local verification harness are under `~/.jcode/scratch/fss-today-mockup-20260909/`. These prototype checks do not claim production Today integration or live provider/device acceptance.

## Decision still needed

Does this queue/detail arrangement and its default density feel right for daily use? Record David's requested adjustments and explicit layout approval before implementing the production Today renderer. No installation, profile migration or live activation is authorized by this prototype.
