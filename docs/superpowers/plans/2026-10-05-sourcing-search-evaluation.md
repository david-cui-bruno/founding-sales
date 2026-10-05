# Replaceable search connector and bounded evaluation

> Execute inline with executing-plans and test-driven-development.

**Goal:** Evaluate Tavily Basic on Callie's actual sourcing hypotheses before wiring unattended daily discovery.
**Architecture:** A provider-neutral discovery search port returns native result URLs/titles/snippets and usage. A fixed-parameter Tavily adapter implements it. A local evaluation tool uses a durable pre-request credit ledger and a single-process lock, so restart/retry cannot erase consumed allowance. Results remain unverified artifacts, not CRM firms.
**Spec:** docs/superpowers/specs/2026-10-04-targeted-lead-sourcing-design.md.

## Constraints
No production scheduling, admission, outgoing messages, account purchase, payment method or paid overage. 20 attempts/day and 600/month for this single-host evaluation ledger. Each Basic request reserves one credit before network; failures retain that debit. Stop on missing/abnormal usage or provider errors. Cross-host/global quotas belong to the future database-backed production runner. A dedicated free key/account must be checked before live use. Native result URLs are candidates, never evidence of company identity or need.

## Tasks
1. [x] Write failing adapter tests, then implement provider-neutral types and fixed-endpoint adapter. One request, no retries/redirects, 15-second timeout, 1MB response limit, max5 results, Basic/general, auto-parameters off, answer/raw-content/images off, include usage. Preserve native attribution; validate/deduplicate public HTTPS URLs. Error codes only, no key/body logging.
2. [x] Write failing evaluation tests, then implement versioned query set (DFW, Providence, Boston; explicit pain, coordination hiring, fit-only), durable daily/monthly ledger and no-duplicate same-day query. Test restart, caps, concurrent locks, invalid state, transport failure and unexpected usage. CLI defaults to dry-run; live mode needs key and fixed ledger location, writes bounded JSON evidence outside repo. No website crawling within the search call.
3. [x] Typecheck/lint/test affected code, independent review, fix substantive findings, update draft PR. Live quality evaluation requires the user's Tavily login/key; don't claim fixtures prove search quality. Preserve a scoring sheet for identity, fit, corroboration, duplicates and usefulness.

## Review focus
No exposed credentials; crash after debit cannot refund; no hidden paid fan-out; no raw third-party instructions executed; malformed/oversized responses safely fail; native URL required; benchmark does not admit leads or schedule production jobs.

Verification: full Node 24 greenfield gate passed, 6,853 tests and 16 existing skips. Independent code review found no substantive findings. Live evaluation remains pending the Tavily free-plan onboarding completion; no search-quality conclusion yet.
