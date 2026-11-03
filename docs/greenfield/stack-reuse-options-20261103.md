# Stack reuse: observability and managed alternatives

November 3, 2026 · [Audit920](https://github.com/david-cui-bruno/founding-sales/issues/920). Source/official-documentation research plus Root's read-only AWS inventory; recommendation only. Scope: this founder-sales Node24 / React / PostgreSQL / AWS workspace, **not** the separate customer-facing maintenance product. No new accounts, SDK installations, traffic export, infrastructure changes or purchases; no synthetic mail/alert sends or SDK payload tests.

## Existing stack and observed gaps

The repository already uses managed infrastructure and established libraries:

- **Application:** Node24/npm workspaces/TypeScript, React19, native Node HTTP handlers, Zod contracts and direct PostgreSQL `pg` queries. Browser assets use **esbuild**, not Vite. [API bootstrap](../../apps/api/src/bootstrap/main.ts), [web dependencies](../../apps/web/package.json).
- **Infrastructure/data:** Terraform, ARM64 ECS Fargate API/worker, RDS PostgreSQL16 with Multi-AZ/35-day PITR, S3, KMS and Secrets Manager. Keep these rather than introducing another cloud/database control plane. [Stack](../../infra/modules/stack/main.tf), [database](../../infra/modules/database/main.tf).
- **Providers:** existing Gmail, Twilio, AWS Transcribe/Bedrock, Cal.com, Tavily and MillionVerifier adapters. Adapter presence is not activation or permission. Domain authority, source provenance, budgets and uncertain-send reconciliation remain application responsibilities.
- **Delivery/testing:** GitHub Actions, Vitest, Testing Library and Playwright. Reuse synthetic-only failure traces/screenshots and exact test diagnostics rather than expecting production error monitoring to diagnose CI races. [Playwright configuration](../../apps/web/playwright.config.ts), [CI](../../.github/workflows/greenfield.yml).

Root's read-only AWS observations, November3:

| Existing telemetry | Observed state |
| --- | --- |
| Metric alarms | 16 |
| Composite alarms | 2: critical OK, warning ALARM; dead-job-unresolved is the metric alarm in ALARM |
| CloudWatch dashboards | 0 account-wide |
| Log retention | API/worker90days; alarm digest14days |
| Notification path | Active Lambda → SNS email with confirmed subscription; enabled07:00 America/New_York daily schedule |

All18 alarms have no direct state-change actions, consistent with the [owner-chosen daily digest](../../infra/modules/alerts/digest.tf). This is not missing SNS configuration; immediate paging would change that decision. Actual inbox receipt/latency was not tested. An October31 alarm transition does not prove stale datapoints. Explicitly querying both CloudWatch alarm types confirms the composites match source; there is no established source/deployment discrepancy.

The diagnosis gap is concrete: [structured logging](../../apps/api/src/bootstrap/log.ts) omits exception stack/cause; [browser caught failures](../../apps/web/src/server/browser.ts) return safe generic refusals; [job failures](../../apps/worker/src/runner/jobRunner.ts) become persisted retry/dead outcomes. Request/job/provider correlation and readable grouped exceptions are missing at these seams. Keep public errors generic, capture unexpected failures explicitly with safe internal categories, and retain domain-health counts/holds for expected refusals. An observability vendor must not become a second CRM or sending authority.

## Decision

**Add one error-monitoring destination, not two: prefer a tightly restricted Sentry error-only integration. Keep CloudWatch for infrastructure, logs and business-health alarms. Defer PostHog until there is a concrete product-usage question worth instrumenting.** This is a fit judgment, not a measured superiority or cost-saving claim. PostHog now also documents error tracking and distributed tracing; “PostHog is only analytics” is not an accurate comparison.

| Priority | Recommendation | Incremental burden / boundary |
| --- | --- | --- |
| Delivered November3, PR923 | Sentry browser + API + worker errors, private browser maps and release/environment tags; native TypeScript context. Replay, tracing, logs, profiling and AI-content collection off. | US no-card/no-paid-upgrade account. Closed technical-event transport, exact ingestion-origin CSP and CI-only source upload; actual wire/provider/original-source proof in [current state](../operations/current-state.md). No database migration or new immediate paging; quota exhaustion and inbox delivery are not claimed. |
| Keep existing; close the operational loop | CloudWatch logs/metrics/alarms, PostgreSQL business state, current job/sending authority. Establish who receives each actionable alarm and how to diagnose its reason. | No new vendor. Dashboard/query/notification ownership still needs work; existing alarm presence is not delivery evidence. Do not infer missing notifications from empty AlarmActions alone: an alarm-digest path exists in the supplied inventory. |
| Consider later | Sampled OTel/ADOT server/worker tracing if latency or cross-service diagnosis becomes a demonstrated gap. Choose one trace backend initially. | Instrumentation/bootstrap, sampling, export/IAM/network configuration and queue context propagation; possible collector lifecycle and extra AWS ingestion/query charges. Not already installed merely because CloudWatch is used. |
| Consider later | PostHog explicit product events/funnels if multiple real users or a repeated UX question justify them; replay remains off. If selecting PostHog errors instead, do not also deploy Sentry for the same events. | Another processor and event taxonomy/identity/deletion work if added beside Sentry; product events do not replace business records. |

Repository/runtime findings above complement the official capability comparison below. Vendor features are **not** proof of installed integrations or a diagnosed incident. The subsequent PR923 delivery has actual runtime/privacy/source-map evidence in [current state](../operations/current-state.md); it does not establish savings, alert inbox delivery or quota-exhaustion behavior.

## Compare capabilities separately

| Capability | Sentry | PostHog | Existing AWS reuse |
| --- | --- | --- | --- |
| Errors / grouping | Groups by stack/type/message fingerprints; configurable rules and SDK fingerprints. Good fit for a dedicated issue/regression workflow. [S1] | Captures web/backend exceptions; automatic fingerprints, custom rules, merging and assignment. A viable single-platform alternative, especially if analytics is already needed. [P1][P2] | Retain logs and alarms; neither a log group nor a threshold alarm supplies the same source-mapped issue-grouping workflow. This is a workflow comparison, not a claim that AWS cannot analyze errors. |
| Browser tracing | Browser instrumentation and distributed propagation can connect browser to backend. Not required for error capture. [S2] | OTel-compatible distributed tracing is documented; session/distinct-ID headers link backend events to browser activity, but those correlation headers alone are **not** an end-to-end span trace. [P3][P4] | ADOT source reviewed here covers JavaScript server-side export, not a proven browser setup. CloudWatch RUM would be a separate collection decision. [A1][A3] |
| Server / worker tracing | Node distributed tracing; non-HTTP/background boundaries need deliberate custom propagation and per-job context. An HTTP trace will not automatically span a persisted PostgreSQL job boundary. [S2] | Generic OTLP receiver; Node SDK can also create/export spans without a separate OTel dependency. Custom worker boundaries still need instrumentation. [P3] | ADOT complements upstream Node OTel and exports to X-Ray/CloudWatch/Application Signals. Prefer it over introducing legacy X-Ray SDKs: AWS says those SDKs/daemon entered security-only maintenance February 25, 2026. [A1][A2] |
| Source maps / releases | esbuild integration or Sentry CLI can upload maps and associate releases; use the existing build tool, not a Vite migration. The esbuild plugin documents limits with `splitting: true`; select its documented CLI/legacy route if needed. Keep maps out of public artifacts and match runtime release tags. [S3][S4] | Source-map upload supports React/Vite/Node; release/commit tagging is documented. Also requires build/release integration, not just an SDK. [P1][P5] | CloudWatch logs do not by themselves upload frontend maps or correlate frontend issues to releases. |
| Product analytics / funnels | Do not choose an error monitor to build behavioral conversion analysis. | Explicit event funnels support ordered steps, conversion windows and breakdowns. This is its clearest additional role here. [P6] | SQL/domain projections are a better first source for authoritative operational outcomes; exporting raw business records to analytics is unnecessary. |
| Session replay | Separate feature; masks text/images/input by default, but URLs/network metadata and console messages remain privacy surfaces. [S4] | Masks inputs by default, **not general displayed text**. URL/network redaction and blocking private DOM regions require configuration. [P7] | No replay needed to maintain existing infrastructure monitoring. |

**What an SDK will not fix:** an approved campaign rejected by a handled classifier is a semantic/business outcome, not necessarily an exception; a stale Gmail coverage hold needs state/reason monitoring; a CI async focus race belongs in test diagnostics, not production error ingestion. A generic 401 can be intentionally safe for the browser: correlate a sanitized server-side reason/request identifier rather than weakening the response or exporting OAuth payloads.

## Pricing observed from official pages

USD advertised values read November 3, 2026; not an account entitlement, quote, forecast or authority to spend. Recheck before adoption. Usage, tax, region, retention and quota exhaustion matter even with a free plan.

| Option | Verified public advertisement | Unverified / caveats |
| --- | --- | --- |
| Sentry Developer | $0, **one user**, unlimited projects; 5,000 errors, 5 million spans, 50 replays, 5 GB logs in the comparison table; email alerts; one uptime and one cron monitor. Team advertised **$26/month billed annually**, Business **$80/month billed annually**, each with default prepaid data. [S5] | Do not confuse the temporary 5,000-replay/month new-user promotion (first three months) with the ordinary 50 allowance. Monthly-billing prices, negotiated terms and excess-event unit costs not verified. No need to enable free-but-unneeded products. |
| PostHog Free | Monthly **1 million analytics events**, **100,000 exceptions**, **5,000 recordings**, **10 GB logs**; no card required, one project, unlimited team members. Free-plan usage stops at limits. Pricing FAQ says free recordings retained one month; paid recordings 90 days; logs default 14 days. [P8] | Paid event/exception/replay per-unit rates and separate tracing allowance not exposed clearly in the retrieved calculator: **unverified**. Paid logs custom retention advertised $0.05/GB/month retained, uncapped by its ingestion billing limit. Do not turn on long retention assuming a $0 ingestion limit caps all charges. |
| CloudWatch / ADOT | CloudWatch advertises usage-based pricing; free table includes 5 GB logs, 3 custom dashboards (up to 50 metrics each), 10 eligible standard alarm metrics, 100 canary runs/month, and 100,000 recorded X-Ray traces/month. [A3] | Account eligibility/existing consumption and actual regional charges not inspected. Application Signals has a limited introductory allowance, not an indefinite free promise. ADOT code reuse does not make storage/queries/collectors free. |

## Safe minimal error-only adoption

A provider approval must cover the new processor, region, access, retention/deletion and intended data scope. ADR0012 forbids credentials in URLs/logs/error pages and keeps private browser state tightly bounded; observability must not create a second content store.

1. **Pin and inspect the actual SDK version and integrations.** Current Sentry docs describe a material defaults transition: in v10, setting `dataCollection` activates its category defaults; from v11 those defaults always apply. Merely retaining the old `sendDefaultPii: false` recipe is not a sufficient future-proof privacy policy. The documented defaults include request bodies, headers, cookies, query parameters and AI inputs/outputs subject to key-based filtering. An empty `dataCollection: {}` is not “collect nothing.” [S3][S4]
2. **Disable rich collection explicitly.** For an adopted SDK version supporting these controls, turn off userInfo, cookies, HTTP headers/bodies, URL query parameters, database query data, queue arguments, stack-frame variables and AI inputs/outputs; omit unused integrations. Disable console/DOM/network breadcrumbs or retain only a closed, scrubbed set. Avoid automatic AI/provider, SQL-parameter or job-payload instrumentation. A disabled category does not scrub manually attached context or `setUser` data. [S3][S4]
3. **Error-only means no replay recorder, no browser tracing integration, no trace sampling/export/propagation, no log/profiling/feedback attachments.** Keep replay session and error-trigger sampling at zero if those options exist; preferably do not include the replay integration. An error-triggered recorder is still replay. Sentry documents an empty `tracePropagationTargets` to prevent trace headers; do not send correlation headers to Google, prospect sites or other third parties. [S2][S4]
4. **Allowlist the outgoing event shape before transport.** Keep technical exception type/sanitized stack, stable internal error code, service, release, environment and non-secret correlation ID. Strip exception messages/causes that embed URLs, SQL values, email addresses, provider responses or user prose; scrub request/referrer URLs, including paths and fragments, not only query strings. Sentry explicitly says scheme/host/path remain collected, so category switches alone are insufficient. Drop an event when its safety cannot be established. `beforeSend` and `beforeBreadcrumb` support this; server-side scrubbing is defense in depth, not permission to export first. [S3][S4]
5. **Specific prohibited material:** OAuth `code`, `state`, PKCE verifier, login hints, access/refresh tokens; Authorization/Cookie/Set-Cookie and CSRF/session values; prospect addresses/phones/names in error strings, DOM text or URL paths; Gmail subjects/bodies/snippets/attachments and private business notes; model prompts/completions containing any of them. Built-in key denylists miss arbitrary free text and innocently named parameters (for example `code`). Hashing an email does not make its collection necessary or anonymous.
6. **Before activation, demonstrate the boundary with synthetic fixtures only:** cover OAuth/private-provider content, browser and worker exceptions, and a minified browser exception with matched maps/release. Inspect the outbound event for forbidden material and establish safe failure/shutdown behavior. Keep upload tokens CI-only and maps out of public artifacts. Review intended alert/quota settings; verify delivery before relying on a new alert path. This research did not run those checks; subsequent implementation evidence is linked above. Existing daily CloudWatch inbox delivery and quota exhaustion remain unverified; no Sentry paging was added. [S3][S5]

**If PostHog is chosen instead:** explicitly disable autocapture, pageview/pageleave, rage/dead-clicks, heatmaps, performance, session recording, console log capture and surveys; permit only exception events through `before_send`, remove default URL/referrer/identity properties, suppress person profiles where unnecessary, use no persistence if feasible, and disable IP capture at the project level. `autocapture: false` alone does not disable pageviews or replay; several options otherwise inherit remote project configuration. Pin defaults/version and inspect actual payloads. This has a wider feature-default surface than a dedicated error-only scope, not proof it cannot be made safe. [P4][P7][P9]

## Operational outcomes are not product analytics

PostHog funnels answer “which product steps did an instrumented user perform, in what window?” For a single founder, click/drop-off samples will be small and often reflect intentional operational stops. They do not establish useful prepared prospects, contact eligibility, delivery, replies, meetings or revenue. [P6]

Keep business outcome denominators in PostgreSQL/domain read models: unique discovered companies → source coverage → useful prepared briefs → separately channel-ready routes; campaign decisions by explicit reason; Gmail connection/coverage age; runnable job age and terminal/unknown outcomes; provider cost and supported commercial outcomes. Distinguish attempted work from provider-accepted effects and unknowns from failures. Emit only bounded counts, latency and stable reason codes to CloudWatch; no per-prospect dimensions or content. Product analytics can later receive approved minimal aggregate/custom events, never become sending authority or an alternate CRM. [Repository job contract](jobs.md), [prepared-prospect measurement guidance](prepared-prospect-architecture-audit.md).

## Three adjacent categories, deliberately bounded

These are alternatives to investigate when their exact complexity is present, **not three more additions now**.

| Category | Reuse candidate / recommendation | Migration and operational burden |
| --- | --- | --- |
| Standards OAuth/OIDC | **Evaluate a focused `openid-client` replacement for existing custom protocol code:** [googleClient.ts](../../apps/api/src/auth/googleClient.ts) owns discovery/JWKS caching, code exchange and signature verification; [idToken.ts](../../apps/api/src/auth/idToken.ts) parses tokens and checks issuer/audience/azp/signature/time/nonce. `openid-client` is MIT, maintains v6 and supplies standard code/refresh/discovery/revocation flows on Node20+ WebCrypto/Fetch. Prefer a maintained protocol library over another identity SaaS. [L1] | Medium/high security-sensitive cutover: preserve the [browser session seam](../adr/0012-browser-session-boundary.md), workspace membership, encrypted cookie custody, state/nonce/PKCE checks, revocation and Gmail-specific scope/coverage semantics. Map current test seams before replacing code. A library does not repair a revoked grant or establish the refresh incident's cause. No new provider/license fee; dependency security upkeep remains. |
| Durable jobs | **Keep the current Postgres queue now.** `pg-boss` is an MIT Node/Postgres library offering transactional enqueue, SKIP LOCKED claiming, retries, schedules, dead letters and OTel; current requirements Node22.12+/Postgres13+. Prefer evaluating it before adding a separate Redis/service plane if generic queue plumbing becomes the actual maintenance bottleneck. [L2] | High migration: schema, enqueue/claim ownership, drain/cutover, scheduling, leases/fencing, existing recovery and unknown-write semantics. Automatic retries must not replay uncertain sends. A queue's transaction guarantees are not exactly-once Gmail/provider effects. Existing domain safety remains custom; adding a second concurrent queue would increase complexity. |
| Uptime / synthetic journeys | **Consider one public non-mutating uptime check**, reusing the advertised Sentry allowance if Sentry is selected; CloudWatch Synthetics is the existing-account alternative for richer scheduled HTTP/browser checks. AWS canaries support Playwright/Puppeteer, availability/latency and screenshots. [S5][A4] | Low for a public URL check, medium/high for authenticated journeys: IAM/Lambda/runtime, synthetic identity, artifact retention, alert routing and ongoing script upkeep. Screenshots/HAR/logs can leak private material. Use fictional fixtures and no Gmail access/sending; a successful landing-page check does not prove sign-in or sender readiness. A recurring canary quickly exceeds 100 free monthly runs; underlying AWS resources also need a cost estimate. |

No recommendation to replace the database, cloud, deployment system or guarded business workflows, self-host an observability suite, or adopt a separate feature-flag/AI-monitoring platform. Avoid dual auto-instrumentation/tracing backends until a concrete need outweighs duplicate cost and context complexity.

## Sources and limits

Official sources read for this note (accessed November 3, 2026):

- **S1** [Sentry grouping/fingerprints](https://docs.sentry.io/product/issues/grouping-and-fingerprints/).
- **S2** [Sentry Node distributed tracing](https://docs.sentry.io/platforms/javascript/guides/node/tracing/distributed-tracing/).
- **S3** [Sentry JavaScript options and collection-version transition](https://docs.sentry.io/platforms/javascript/configuration/options/).
- **S4** [Sentry React data collected](https://docs.sentry.io/platforms/javascript/guides/react/data-management/data-collected/); [esbuild map/release upload, code-splitting limits and public-map warning](https://docs.sentry.io/platforms/javascript/guides/node/sourcemaps/uploading/esbuild/).
- **S5** [Sentry pricing](https://sentry.io/pricing/).
- **P1** [PostHog error tracking](https://posthog.com/docs/error-tracking).
- **P2** [PostHog grouping exceptions](https://posthog.com/docs/error-tracking/grouping-issues).
- **P3** [PostHog distributed tracing](https://posthog.com/docs/distributed-tracing).
- **P4** [PostHog JavaScript configuration/defaults and correlation headers](https://posthog.com/docs/libraries/js/config).
- **P5** [PostHog source maps](https://posthog.com/docs/error-tracking/upload-source-maps).
- **P6** [PostHog funnels and conversion semantics](https://posthog.com/docs/product-analytics/funnels).
- **P7** [PostHog replay privacy](https://posthog.com/docs/session-replay/privacy).
- **P8** [PostHog pricing and retention/billing FAQ](https://posthog.com/pricing).
- **P9** [PostHog collection/privacy controls](https://posthog.com/docs/privacy/data-collection).
- **A1** [ADOT JavaScript export options](https://aws-otel.github.io/docs/getting-started/javascript-sdk/).
- **A2** [AWS X-Ray SDK maintenance notice](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-nodejs.html).
- **A3** [CloudWatch pricing/free allowances](https://aws.amazon.com/cloudwatch/pricing/).
- **A4** [CloudWatch Synthetics canary capabilities](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries.html).
- **L1** [`openid-client` official repository, features/runtime/support](https://github.com/panva/openid-client).
- **L2** [`pg-boss` official repository, features/requirements/license](https://github.com/timgit/pg-boss).

Limits: documentation is mutable and can describe a newer SDK than one adopted. No Sentry/PostHog account/contract, security certification review, outbound payload capture, Node24 compatibility exercise, representative usage estimate or measured savings/performance comparison was performed during this audit. Free-plan limits and alert destinations need account readback; improvements require application-specific instrumentation rather than vendor defaults. AWS configuration was read, but inbox delivery and incident root causes were not established.
