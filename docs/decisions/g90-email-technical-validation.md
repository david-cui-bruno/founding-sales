# g90: an address is checked by the worker, and its domain decides

**Date:** 25 September 2026 · **Lane:** g90 email route validation · **Spec:** 7.2, 7.4, 9.1,
12.4, 13.1, 13.2, 14.2 · **Found by:** lanes g84 and g88

## What was wrong

An email address added or imported from the Mac — Add firm, Import, the carry,
`/contacts/routes/add` — was created `technical_validation = 'unknown'` and `eligibility =
'candidate'`, and nothing ever changed either. `decideRouteEligibility` (`route-policy.1`)
makes a route usable only with a passed technical validation, so no such address could
ever become usable, and once sending opens on about 1 October every email step to such a
contact holds as `route_candidate` at PR 216's frozen-route check. Lane g88 added "Confirm
this number" for phones and deliberately not for addresses: a person cannot tell by
looking whether mail reaches one.

## Decisions

### 1. What `passed` means: `email-validation.1`

Checked in this order, and the first answer is the answer
(`packages/domain/crm/routeValidation.ts`):

| # | Check | Outcome | Reason code |
|---|---|---|---|
| 1 | The address is not RFC 5321-sane | `failed` | `syntax_invalid` |
| 2 | The domain is, or is under, a special-use name | `failed` | `domain_reserved` |
| 3 | Another route in the workspace with the same address has **failed** | `failed` | `known_bad_route` |
| 4 | The domain has an MX with a real exchange | `passed` | `mx_present` |
| 5 | The domain's only MX is RFC 7505's null MX (`0 .`) | `failed` | `null_mx` |
| 6 | The domain does not exist (NXDOMAIN, `ENOTFOUND`) | `failed` | `domain_not_found` |
| 7 | No MX (`ENODATA`), and an A or an AAAA record | `passed` | `implicit_mx` |
| 8 | No MX, and neither an A nor an AAAA record | `failed` | `no_mail_host` |
| 9 | A timeout, SERVFAIL, a refused query, or any other resolver error | no answer | `dns_timeout`, `dns_servfail`, `dns_refused`, `dns_error` |

**Sane syntax** is narrower than legal on purpose: at most 254 characters (RFC 5321's
256-octet path less its brackets); a local part that is a dot-atom of 1 to 64 ASCII
characters; a domain of at least two LDH labels of 1 to 63 characters, at most 253 in
all, whose last label has a letter (so a dotted quad is not a domain). A quoted local
part, an address literal (`[192.0.2.1]`) and a non-ASCII local part (SMTPUTF8) are legal
in RFC 5321 and are not an address a firm hands out, so they fail. An internationalized
*domain* is fine: it is asked for as its A-label.

**Special-use names** are answered without DNS, because some resolvers answer for them
anyway: `test`, `example`, `invalid`, `localhost`, `example.com`, `example.net`,
`example.org` (RFC 2606, 6761), `local` (6762), `onion` (7686), `alt` (9476), `arpa`
(3172, and 8375's `home.arpa`) and `internal` (ICANN's private-use name). That is the
whole deny list. **Role mailboxes (`info@`) and disposable providers are left out**: they
receive mail, and whether an address is worth writing to is not what 7.4 asks.

**Known bad means failed, not retired.** The brief said "a retired or invalid route with the
same normalised address". A retirement says an address does not reach *that* firm or
person — 9.1's "wrong number", an association fact — and an address moved from a
firm-level route to a contact-level one, or corrected from Dana's to Robin's, is retired
where it was. Counting that as undeliverable would make the address invalid for ever at its
right home, because an invalid route is final for its association. What the check counts
is every route with the same address whose `technical_validation` is `failed`: a bounce
(12.4) writes that, this check writes that, and a route retired after failing keeps it.
`email_addresses_by_address` serves the lookup.

**The implicit MX is accepted.** RFC 5321 section 5.1: with no MX, "the domain is to be
treated as if it had an MX with the domain itself as the exchange". Gmail, which sends for
Callie, follows it, so mail to such a domain is attempted, and calling it undeliverable
would be wrong by the standard the sender uses. The cost is known: a parked domain with an
A record and no mail server passes. That is the cheaper mistake. A false pass is corrected
by the first bounce, which makes the route invalid (12.4) and counts against the mailbox's
health; a false fail is permanent, because an invalid route stays invalid at its
association and the founder cannot re-add it.

**No answer is not an answer.** Only NXDOMAIN, "no such record" and a null MX are definite.
Everything else leaves the route `unknown` and asks again later (section 4). A lookup that
has not answered after five seconds is a timeout, and the production resolver's own
timeout is two tries of two and a half seconds.

**Not done, on purpose:** SMTP callouts (they probe a stranger's mail server, are refused
or lied to by the providers that matter, and can list the prober), third-party
verification services, and sending anything.

### 2. Association: what a check cannot supply — import counts as vouched (decided 25 Sep 2026)

**Outcome:** import counts as vouched (decided 25 Sep 2026). David delegated the call to the
coordinator's recommendation, which kept the rule as built: `salesperson` and `import` both
record confidence 1 when the check passes. The rest of this section is the reasoning it was
decided on.

A passed check says mail can reach the domain. It says nothing about whether the address
is *this person's*. `route-policy.1` needs a recorded association confidence for that —
`decideRouteEligibility` refuses a null confidence even for a trusted source, and
`email_addresses_usable_is_evidenced` refuses a usable row without one — and every address
the Mac adds arrives with none. So a validator that only validated would have left every
Add firm and Import address a candidate, and the brief's own release check ("an imported
address ends usable") could not pass.

The rule this lane adds, in one constant (`MEMBER_ENTERED_SOURCES`): **when the check passes
and the route has no recorded confidence, an address a member entered themselves —
`salesperson` (Add firm, typed) or `import` (their own file, the carry) — records a
confidence of 1.** The person who entered it vouched for it. It is the value lane g88's
"Confirm this number" records and the drill's own address carries. The audit event says
which basis it used (`confidenceBasis: recorded | vouched | none`), so these routes can be
found again.

What it does not do: replace a recorded confidence (a website's 0.5 stays 0.5 and stays a
candidate); vouch for `research_provider` or `website` (a provider that did not measure has
not vouched for anything); vouch for `reply` (trusted by the policy, but nothing creates one
yet); change `route-policy.1`'s thresholds or its trusted sources.

Why this was put to David rather than decided by the lane: an imported file may be a bought list,
and the carry imported whatever the old app held. The risk is bounded — a usable address
is written to only when a person enrols its contact in a sequence (11.2), and a bad one
bounces once and is invalid after — but whether an import should count as vouched is a
product decision. Removing `'import'` from `MEMBER_ENTERED_SOURCES` makes imported addresses
stop at "Deliverable domain — not usable yet" instead, with nothing on the Mac to move them
on; the Firm page already has the words for that state.

### 3. Where it runs: the `route.validate` job

A new job kind, `route.validate`, protected by **business uniqueness** (Appendix C does not
name this work; `jobKinds.ts` says why the protection fits). The key is
`route-validate:{route}:{version}:{round}`, so a route that moves to a new version is new
work and nothing about an older version blocks it. The payload is `{ routeKind: 'email',
routeId, routeVersion }`; a phone payload is refused.

The handler (`apps/worker/src/handlers/routeValidate.ts`, body in `runEmailRouteValidation`)
reads the route without a lock, checks it, and only then writes, through
`recordEmailRouteValidation` in `routes.ts`: a compare-and-set that re-reads the route and
the firm `FOR UPDATE` and writes only while the route is still the `candidate` with
`technical_validation = 'unknown'` at the job's version. The write records the validation,
the confidence (section 2), `decideRouteEligibility`'s eligibility and policy version, bumps
the version, and writes `route.email.validated`. A second run finds the route moved on and
writes nothing; the runner commits the write with the completion, so a stolen lease rolls it
back. An unanswered check writes nothing to the route and records
`route.email.validation_deferred` with the resolver's reason, so an operator can tell a
resolver that is failing from a queue that is not running. Every outcome completes the job:
throwing on a resolver's bad minute would end in a dead job and a critical alarm about a
route the sweep asks about again anyway.

DNS is asked inside the runner's open transaction (the runner opens it before the handler),
but no row is locked while it is, and the worst case is about ten seconds (MX, then A and
AAAA together).

**The resolver** is injected. Production gives the process's own (`node:dns/promises`
`Resolver`, reading `/etc/resolv.conf`, which in the VPC is the Amazon-provided resolver the
worker already uses for every hostname); tests give a table. It needs no credential, no
provider and no deployment switch, so, like `retention.batch`, the handler is registered in
every deployment. The worker security group already allows egress, and VPC DNS support is
on (`infra/modules/network`), so no infrastructure changes.

### 4. When it runs, and how often it asks again

* **When an address is created** unchecked: `addEmailRoute` enqueues round `new` in the
  command's own transaction — an import row refused after that point takes its job back with
  it. A caller that brought its own verdict (`passed` or `failed`) is not second-guessed.
  There is no path that changes an address in place today (`routes.ts` adds, verifies and
  retires); a lane that adds one must enqueue.
* **The sweep** (`route-validation`, one of the scheduler's sources): unchecked candidate
  addresses at active firms, unchanged for **10 minutes**, oldest first, at most **20 per
  pass** across all workspaces. The round is the UTC **hour** while the route changed in the
  last day and the UTC **day** after that, so a domain whose DNS keeps failing is asked about
  hourly for a day and daily after, never twice in a round. A route whose creation job is
  still waiting is skipped. Both job lookups are equality on `jobs_idempotent`, so a route
  already asked about this round never takes a place in the limit, and nothing starves.
  The same sweep is the backfill: every address the carry and the Mac left `unknown`
  before this release is found by it, twenty a minute.
* **"Check again"** on the Firm page: `POST /contacts/routes/check { routeKind: 'email',
  routeId, routeVersion }`, a command with a receipt and one job per command id (round
  `check-<hash>`). It queues nothing for an address already usable or already passed, and
  refuses `route_version_stale`, `route_invalid` (a definite answer is a new retrieval, not
  a retry) and `route_retired`.

**The one scan without an index.** The sweep's scan of `email_addresses` has no partial
index to use, because adding one is a migration and this lane has none. At one workspace's
size it is a sequential scan of one table a minute. The index to add with the next
migration: `CREATE INDEX email_addresses_unchecked ON email_addresses (updated_at) WHERE
eligibility = 'candidate' AND technical_validation = 'unknown'`.

### 5. Nothing lowers a usable route

The write is only ever made to an unchecked candidate, so a `usable` route is never touched
by a check, answered or not; an `unknown` one stays `unknown` on no answer. A bounce is still
what makes a usable address invalid (12.4). Nothing a check writes can move a route a fence
has frozen, because a fence only freezes a usable route.

### 6. What the founder sees

The Firm page replaces g88's sentence under the addresses ("needs a validation Callie
cannot do by hand") with a state beside each address:

| Route | The page says |
|---|---|
| `candidate`, `unknown` | **Checking…** and a **Check again** button |
| `usable` | **Deliverable domain — usable** |
| `candidate`, `passed` | **Deliverable domain — not usable yet: nothing says this address is this person’s** |
| `invalid` (or `failed`) | **Mail can’t reach this address — invalid** |
| `retired` | nothing more than the chip |

The brief's third example was "No mail server for this domain — invalid". The page cannot
tell a missing mail server from a malformed address or a bounce — the reason is in the audit
event, not on the row, and there is no migration here to put it there — so it says the thing
all three have in common.

The state comes from the route DTO's `technicalValidation`, a new optional field the Firm
page read sends only when asked for its second version (`pageVersion: 2`). The route DTO is a
strict object and desktop 1.0.5 parses it with its own strict schema, so the key would break
every Firm page on the installed build; without `pageVersion` the answer is the first
version exactly, and `apps/api/test/emailValidation.test.ts` parses it with 1.0.5's schema.

## Compatibility

**No migration**, and the schema range is unchanged: `jobs.kind` is text, and every column
the check writes exists. One new job kind, one new endpoint (`/contacts/routes/check`), one
new optional request field and one new optional response field. An app-only release: the API
and the worker together (the API enqueues the jobs the worker claims), then the desktop,
because the new desktop's `pageVersion: 2` is refused by an older API's strict request
schema. Desktop 1.0.5 keeps working against the new API unchanged.

After the deploy the sweep works through every address still `unknown` — the carry's, and
anything added since — at twenty a minute, and each gets its answer within a minute or two
of being asked.

## What would change this

* A migration that stores the validation reason on the row would let the page say "no mail
  server" rather than "can't reach".
* A `route-policy.2` that trusts `import` at the policy level would make section 2's rule a
  policy rather than a recorded confidence; the rows written under this rule are findable by
  their audit events.
* A verification provider (7.4 "versioned provider/source policy") would be a second
  resolver behind the same interface, and a new rule version.
