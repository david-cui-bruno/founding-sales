# Using the contact workspace

## Daily flow

1. Open **Today**. It shows real warm contacts and due commitments. Raw cold/hot research stays in the background instead of becoming a review queue. Active warm work pauses discretionary cold/hot work, but not genuine callbacks or post-interview commitments.
2. Select a name. The overview shows identity, the **known, partial portfolio**, and a supported reason to contact. Unknown holdings stay unknown. Scores, source evidence and manual controls are inside **Details**.
3. Choose **Call** or **Email**. There is no required Next sequence.

For CSV imports, choose the import source channel or include an explicit **Segment** column (`warm`, `hot`, or `cold`). A free-text Source column does not select a cadence. Custom imports without a Segment currently default to warm, so cold lists must be identified rather than left at that default.

## Calling

**Call** shows the selected number and an explicit **Open Phone** confirmation when the local capability and compliance checks permit it. It never uses Callie's own prospecting voice. A Phone handoff does not prove a connected call. Afterward, use **Activity** to record what actually happened, including a promised callback or an opt-out. No automatic dial or text is introduced by this redesign.

## Email

**Email** opens the saved draft for that person and contact. With an available configured model, a new draft is prepared using the supplied sales playbook and supported facts. Otherwise the app says drafting is unconfigured and allows manual writing. Private local notes are not included in model context.

Edits persist across closing the composer and restarting the app. Review the recipient, subject, message, sender and footer. **Send** is the only action that dispatches through Gmail. An accepted result does not establish delivery, reply, interview or a sale. If the result is unknown, check Gmail Sent and do not resend the draft.

If a contact changes, explicit reopening starts a fresh reviewed target and preserves the old unsent draft locally rather than silently retargeting its text. A contact change cannot bypass an uncertain send.

## One-time setup

See [outreach setup](outreach-setup.md). **Settings → Connections** accepts your own OpenAI key/model, Google Desktop OAuth credentials, sender name and postal address. Click **Connect Gmail** to authorize the account. Nothing connects or sends merely by opening Settings.

Gmail permission is send-only plus account identity. Read replies in Gmail and record opt-outs in FSS before further outreach. The app does not automatically read replies or infer unsubscribe requests.

## Honest boundaries

The queue-capacity meter describes queued discretionary calls, not completed daily dials. Source/provider fixtures do not prove a live account works. Candidate package tests use fictional isolated profiles. Real-profile upgrade, real provider authorization, and live outreach remain separate acceptance steps.
