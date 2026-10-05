# Search-provider evaluation

The first connector is Tavily Basic, behind `DiscoverySearchProvider`. This is an operator-run quality evaluation, not production continuous discovery. No firms, candidates, messages, deals or recurring jobs are created. Only native search URLs/titles/snippets are saved; identity, geography and maintenance need remain unverified.

## Setup and running

Use a dedicated free Tavily account with paid overage disabled and no payment method. Confirm available credits before running: this local ledger cannot see calls made in other apps or on other machines. The account key is supplied through `FSS_TAVILY_API_KEY` in the process environment, never as a CLI argument or in source files. Do not paste it in chat.

With Node 24, preview without network:

```
node apps/worker/src/sourcing/evaluateMain.ts --dry-run
```

After the key is securely available in the environment:

```
node apps/worker/src/sourcing/evaluateMain.ts --run
```

Nine versioned queries cover DFW, Providence and Boston, each with an explicit-burden hypothesis, a coordinator-hiring hypothesis and a fit-only comparison. A search phrase is not a classifier: vendor advertisements, physical-repair roles and generic tenant workflows are expected false positives to measure.

A run makes at most nine Basic requests and reserves one credit for each. Automatic parameter selection, advanced search, answers, raw content and images are disabled. Requests have a 15-second deadline, a 1MB response limit and no retry or redirect. At most five hits are retained per query. The tool stops on the first provider error or unexpected usage.

## Ledger and limits

Artifacts live in `~/.local/share/callie/sourcing-evaluation/`, outside the repo. The durable ledger debits **before** sending. All attempts, including failed or abandoned requests, count toward 20/day and 600/month (UTC). The same query version is not repeated the same day. Caps describe this single-host tool, not total Tavily-account usage. The production runner will need shared PostgreSQL reservations before activation.

The lock serializes runs. A process crash leaves the lock behind deliberately; inspect that no evaluation process remains before manually removing only `run.lock`. Never delete or reset `state.json` to retry. A corrupt ledger, clock regression, or unexpected usage requires investigation. Preserve the ledger when moving machines; do not run the same account on multiple evaluation hosts.

Each attempt has a JSON artifact with provider, query/version, cohort, retrieval time, provider request ID, exact returned URL and bounded title/snippet. No key or provider error body is stored. A crash can debit an attempt without a result artifact; that is an unknown outcome, not a free retry.

## Quality review before scheduling

For each hit, record:

| Check | Values |
| --- | --- |
| Actual property manager, identified correctly | yes / no / uncertain |
| Supported target geography and residential fit | yes / no / uncertain |
| Employer/firm-owned source or corroborated attribution | yes / no / unavailable |
| Explicit relevant coordination burden | yes / context only / no |
| Role distinguishes coordinator from physical technician | coordinator / technician / unknown / not applicable |
| Duplicate of another result or existing CRM firm | yes / no / uncertain |
| Useful new lead after source verification | yes / no / review |

Review source pages with the existing bounded fetcher. Search snippets and crawl timestamps do not establish current demand or publication dates. Report useful unique firms per request, false positives by query family, source availability and corrections. Do not set a success percentage before seeing a real batch or claim a small benchmark predicts conversion. If coverage is weak, adjust the query families or compare another connector through the same interface.

Provider contracts checked 5 October 2026:
- https://docs.tavily.com/documentation/api-credits
- https://docs.tavily.com/documentation/api-reference/endpoint/search
