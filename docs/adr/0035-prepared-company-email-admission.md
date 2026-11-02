# 0035: Prepared own-site companies enter the approved campaign from a published, checked business address

## Status and scope

Accepted November 2 2026 by David for the Step 3 campaign. It amends [ADR0013](0013-approved-email-campaign-admission.md) and [ADR0016](0016-automatic-research-campaign-composition.md): the campaign still admits only through its approval, caps, holds, expiry and the shared send gate, and it grants no sending, Gmail capture, LinkedIn action or contact. Owner sending stays OFF; production enrollment still needs an approved campaign.

Why: the strict-publication Firms of ADR0013/0016 are empty, so no company was campaign-eligible, while the prepared own-site capture ([ADR0034](0034-company-first-callable-supply.md)) already retains contact, about and team pages that often publish a business address.

## Decision

**Email-ready.** A prepared company (the prepared brief says business context, no contrary context, a company page; candidate website host, one company per host) is email-ready when its admitted own-site pages, read through the one shared prepared admission rule, publish an exact address in a block. The address is never guessed or built from a name pattern. It must sit at the company's own host or the host the page was captured from; consumer and disposable domains, no-reply/billing/careers-style mailboxes and blocks with suggestion, referral, vendor or "powered by" wording are refused. Several published addresses: a role mailbox first (info, hello, contact, office, …), then alphabetical. A mismatched domain is refused, as `supportedBusinessEmail` already refuses it. Evidence expires with the earliest page, capture or source deadline and at most seven days after retrieval.

**Check before admission, free and in-house.** The address is checked once (syntax, a real MX record, no consumer/disposable domain, reserved names refused; the RFC 5321 implicit-MX fallback does not admit; no SMTP probing, no third party). A resolver error answers nothing and is asked again next pass, so DNS failure fails closed. The answer is recorded without the address (`outreach_email_verifications`, a lowercase digest key): valid admits for seven days, invalid is not asked again for thirty. The check sits behind a one-method interface so a paid verifier could replace it later; none is built. The database also refuses a prepared admission row whose route address has no valid check in the last seven days.

**Admission.** The worker's `outreach.email_admit` pass runs every ten minutes for an unrevoked, unexpired campaign with lifetime and daily room. It takes email-ready companies in the prepared list's priority order, checks each, and admits valid ones through the existing owners: campaign authority (owner must be a current active admin; the worker acts for that approved campaign, never as the user), email assessment, contact/route, outreach plan, enrollment and the cap-history row (`source_kind='prepared_capture'`, candidate revision recorded). Lock order is the source lifecycle, send gate, Today, sourcing identity, campaign, then candidate and run. Suppression, holds, replies, uncertain sends, expiry and the 25/5 caps are the existing ones. The Firm is always new: a company whose name or host already matches any Firm (a customer, a Calling preparation, a stopped or replied company) is refused. Time zone is the existing TX/RI/MA rule, else the state's single zone; a state spanning zones (and a Texas city not listed) is refused rather than guessed.

**Nationwide.** Campaign regions may be any of the 50 states and DC (migration 0157 widens the CHECK). Email depends on no state posture.

**Copy.** The first email and every follow-up end with one composed footer: the approved signature, `Callie, AI maintenance coordination · <postal address>` and `If this isn't relevant, just reply and I won't email again.` The postal address is required (a send without one holds); opt-out links stay forbidden. `{booking_link}` is filled from the admin-set `booking_link` workspace setting (https only).

**Whole mailbox, not a suffix.** An address is a whole whitespace-delimited token under the reviewed email parser; a token the parser refuses is refused whole, never re-scanned inside (`a(b@host` is not `b@host`).

**Prepared run, not research run.** A prepared candidate is valid by its prepared brief whatever its qualification run's `reason` (most real ones carry `invalid_evidence`). The admission row (`source_kind='prepared_capture'`, naming the exact enrollment, plan, candidate revision and run) is the proof execution eligibility and attribution accept in place of `reason IS NULL`; research sources keep the strict test.

**Openings.** A prepared admission has no opening-copy source, so a campaign with an opening policy would hold every one. The two exclude each other: the pass skips (and admission refuses, `opening_policy_configured`) a campaign that has an opening policy, and opening approval refuses (`prepared_admissions_present`, control `approvalState: unavailable`) once a prepared admission exists.

**No starvation.** The pass excludes candidates with a current invalid check and everything already tried before the list's limit, and lists again (at most eight lists of room+10 per campaign) until room is filled. The check and its record commit on their own; each admission is its own transaction, because the `outbound_fence` runner provides none.

## Consequences and limits

Volume is bounded by caps (25 lifetime, 5 a day) and by how many prepared companies publish an address at their own host with a working MX and a resolvable zone. Free DNS cannot tell a catch-all or a dead mailbox from a live one: bounces and replies remain the signal. The company name in the email is the retained discovery label; identity is not independently verified (ADR0034 unknowns). Verification is not re-run at first send; a valid check is at most seven days old at admission. Real usefulness, hosted routing and sending remain separate outcomes.
