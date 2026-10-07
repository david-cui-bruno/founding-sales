# Mailbox warm-up and delivery ramp

Researched October 7, 2026. Research only: no sending settings, recipients, or messages changed.

David confirmed the sender mailbox is new or barely used. Treat prior sending
history as unestablished; do not initialize it as already warmed.

## What the providers establish

Google recommends starting with low volume to engaged recipients, increasing gradually,
maintaining a consistent rate, avoiding bursts and sudden doubling, and reducing volume
when bounces or deferrals appear. It recommends SPF, DKIM and DMARC, low complaint rates
(aim below 0.10%; avoid 0.30% or higher), and easy opt-out. Its guidance favors wanted,
subscribed mail; authentication or warming does not make unsolicited mail wanted.
Google publishes no universal mailbox schedule such as five/day for five days or a
mandatory two-week waiting period. Those would be operating choices, not Google rules.
Google also says third-party open rates are not a reliable delivery diagnosis.
[Google sender guidelines](https://support.google.com/mail/answer/81126?hl=en).

Workspace's published ceiling is 2,000 messages/user/day for standard accounts and 500
for trial accounts, subject to other recipient limits and account restrictions. These
are rolling 24-hour limits, can change, and are not recommendations for cold-email
volume. Manual sends, aliases and other account activity matter to account usage.
[Google Workspace limits](https://knowledge.workspace.google.com/admin/gmail/gmail-sending-limits-in-google-workspace).

Our Gmail API transport sends through the authenticated mailbox. Google operates a
dynamic outbound mail-server network; this is not a dedicated sending IP provisioned
for this application. Consequently, importing a dedicated-IP warm-up table would be
the wrong operational model. Domain and sending behavior still matter. This conclusion
combines the actual transport with [Google's send API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
and [Google outbound infrastructure](https://support.google.com/a/answer/60764?hl=en).
Twilio explicitly distinguishes dedicated-IP warming from its already-shared pools;
that is evidence for the distinction, not a Google mailbox schedule.
[Twilio IP warm-up](https://www.twilio.com/docs/sendgrid/concepts/reputation/warm-up-ip-addresses).

## Two different things sold as warm-up

**Gradual real sending:** build a consistent history using real correspondence and
carefully controlled campaign volume, monitoring outcomes before increasing capacity.
This aligns with the Google guidance above.

**Synthetic engagement networks:** Instantly describes pooled accounts exchanging
messages and automatically moving them from spam to inbox. It recommends at least two
weeks and a warm-up score above 90%, but explicitly says its score measures warm-up
placement, not campaign placement. These are that vendor's product claims, not verified
universal effectiveness or Google's endorsement.
[Instantly warm-up documentation](https://help.instantly.ai/en/articles/5975329-how-warm-up-works-and-why-it-s-important).

GMass reports that Google required it to shut its warm-up system down or lose Gmail API
access in 2023. This is a first-party account of GMass's experience, not independently
published Google adjudication of every current service. It supports caution about
making synthetic engagement a dependency; it does not establish that gradual real
sending is prohibited.
[GMass shutdown notice](https://www.gmass.co/blog/warmup-shutting-down/).

Instantly separately offers campaign ramping: start at two campaign emails/day and add
two/day until the configured maximum. That illustrates an actual volume progression,
but is a vendor-specific setting, not evidence that any particular inbox can safely
follow it. [Instantly campaign slow ramp](https://help.instantly.ai/en/articles/10056946-campaign-slow-ramp-system).

## Monitoring at our volume

Postmaster covers personal Gmail recipients; it is not a complete view of business
mailbox delivery. Low-volume days can have missing data for privacy, updates normally
lag around 24 hours and can take longer, and low reported spam rates can coexist with
mail already filtered to spam. Missing data must remain unknown, not healthy. There is
no published universal minimum in this documentation.
[Google Postmaster dashboards](https://support.google.com/mail/answer/14668346?hl=en).

Proposed practice: inspect actual received-message authentication, provider responses,
delivery failures, recipient opt-outs, real replies and available reputation reports.
A Gmail API success or provider message ID is evidence of submission, not proof of
inbox placement. A few controlled inbox-placement tests are diagnostics, not a
statistically representative campaign result. At five sends/day, one adverse event is
material and percentages are unstable; investigate events rather than claiming a
clean reputation from tiny samples.

## Existing implementation and gaps to assess

Repository inspection by the parent agent found an existing mailbox ramp, rather than
a permanently fixed five/day allowance:

| Completed healthy sending days | Daily cap |
| --- | ---: |
| 0–4 | 5 |
| 5–9 | 10 |
| 10–14 | 15 |
| 15–19 | 25 |
| 20–29 | 35 |
| 30+ | 50 |

Sources: `packages/domain/outbound/types.ts`, `packages/domain/outbound/ramp.ts`
and the worker's wired send-day-close handler. Transport:
`packages/domain/mail/gmailClientHttp.ts`.

The current healthy-day rule can count a day with only one automated send; it does not
require meaningful exposure near that stage's cap. Below 20 sends it tolerates one
bounce and one opt-out; at 20 or more it blocks advancement above 5% bounce or 10%
opt-out. Authentication, observation coverage and provider warnings/errors are also
checked, but authentication comes from the operator checklist rather than a live DNS
check; `providerWarning` is currently false without a Postmaster feed, and observed
errors provide only a proxy. These thresholds are application policy, not
provider-certified safe levels.

Recommended next design audit, before claiming the ramp is sufficient:

1. Require evidence of actual volume at the current stage before graduating; elapsed
   healthy days with one send must not justify a sudden high-volume jump.
2. Examine pacing inside the two-hour morning window. A daily cap alone cannot prevent
   a burst at 10:00; the parent's focused search did not find dedicated message pacing.
3. Make hold, rollback, inactivity recovery and noisy/missing health data explicit.
   Distinguish message submission, delivery failure and inbox placement.
4. Account for non-campaign mailbox activity when planning headroom. Follow-ups consume
   real sending capacity; capacity is not a quota that must be filled with new leads.
5. Check mailbox/domain age, historical actual volume, authentication on received mail,
   account restrictions and telemetry coverage before selecting numeric stages.

Recommendation: retain an adaptive real-sending ramp as the approach; do not add a
synthetic warm-up service by default. There is no evidence here for a universal fixed
duration or guaranteed safe daily number. Keep shipping discovery, replies and booking
while sending capacity develops; warming need not freeze development.
