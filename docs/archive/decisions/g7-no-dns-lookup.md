# G7-2: the authentication gate is a person's checklist, not a resolver

**Date:** 20 September 2026 · **Lane:** G7-2 sending · **Spec:** 12.7

## The requirement

"SPF, DKIM, and DMARC must pass before automated sending is enabled. Google Postmaster
Tools or equivalent domain diagnostics are part of the admin checklist."

The obvious implementation is to resolve the TXT records and decide. FSS does not.

## Decision

`sending_domains` carries four booleans and two timestamps: `spf_pass`, `dkim_pass`,
`dmarc_pass`, `postmaster_reviewed_at`, `authentication_checked_at` and
`authentication_checked_by_user_id`. An admin sets them through
`POST /outbound/authentication`. **No code path in this repository performs a DNS
lookup.**

The gate is a CHECK rather than a runtime test:

```sql
CONSTRAINT sending_domains_enable_requires_authentication
  CHECK (automated_sending_enabled = false
         OR (spf_pass AND dkim_pass AND dmarc_pass AND postmaster_reviewed_at IS NOT NULL))
```

## Why not resolve

**A resolver answer is a snapshot of a cache.** The record that matters is the one the
*receiving* mail provider sees, resolved from their network at the moment they evaluate
the message. A TXT lookup from a Fargate task tells you what one resolver had cached a
moment ago, which is correlated with that and is not it.

**Parsing DMARC correctly is a project.** Alignment modes, subdomain policies,
percentage rollout, `sp=`, reporting addresses. A gate that opens on a `v=DMARC1` prefix
match is a gate that opens on a misconfigured record, which is worse than no gate at
all, because somebody will believe it checked.

**DKIM cannot be verified by lookup.** The selector is in the header of a message that
has not been sent yet. "Is DKIM passing" is a question about delivered mail, and the
place it is answered is Postmaster Tools — which is exactly why 12.7 puts Postmaster in
the same sentence.

**An automated gate would be trusted more than it deserves.** An admin who ticks four
boxes knows they asserted something. An admin who watched a green tick appear believes
the system checked, and will not look again when it silently starts failing.

## What the row records instead

Who said so and when. `authentication_checked_by_user_id` is a real membership foreign
key and `sending_domains_passes_are_checked` refuses a pass with no confirmation behind
it, so "SPF passes" is always attributable. That is the only evidence that exists for a
claim this process cannot verify, and it is better evidence than a cached lookup.

Re-running the checklist with any leg failing turns `automated_sending_enabled` off in
the same statement — the precondition is continuous, not a one-time ceremony — and the
API test asserts exactly that.

## When this should change

When FSS ingests Postmaster Tools or DMARC aggregate reports, the signal becomes
*delivered-mail* evidence rather than a lookup, and it belongs in the ramp's health
conditions beside bounces and opt-outs. That is a real improvement and it is a
different mechanism from resolving a TXT record at send time, which this decision
refuses on its merits rather than as an interim measure.
