# Known-company page extraction

This opt-in desktop path researches an **existing, selected account**, not an unknown company. It reuses the current selected-company command, durable job reservation, protected fetch, evidence receipt, account projection and settlement logic. It does not call company discovery, create another account, discover contacts or send outreach.

## Flow

1. A trusted main-process research configuration explicitly includes `researchLimits.knownCompanyExtraction` and approved `permittedSources`.
2. The existing selected-account command enqueues and claims its durable job before network activity. The exact extraction capability is persisted inside that job's limits and must match the current explicit approval inside the atomic fresh-claim transaction. Removing or changing approval leaves unmatched jobs queued, without a new reservation. Committed evidence can still settle.
3. The page adapter reads only configured HTTPS URLs on the exact account hostname, including a specifically approved `/about` URL. Existing DNS pinning, source allowlist, redirect, byte, page and cancellation checks still apply. No browser, JavaScript execution or automatic link following is added.
4. Cheerio's slim parser extracts bounded complete text blocks. The source retains the raw HTML SHA-256 and a reproducible parsed-text excerpt. Hidden/raw-text/third-party containers are conservatively omitted. This is not rendered CSS visibility or an independent truth check.
5. One Responses API request selects exact complete quoted blocks using structured output, with no search tools. Both the provider and page adapter validate source/block membership and whole-block equality. The model cannot supply source permission, a new source URL, a numeric portfolio count, contact routes or prospect-stated pain.
6. Quotes are admitted through the existing account evidence transaction. `ownership` and `portfolio_description` are textual claim keys. A quote such as “over 250 units” remains that exact text; the exact numeric portfolio field remains unknown. Quotes can enter the existing bounded company-only unsent-draft context, with its existing conflict and source checks.
7. Replaying the same selected command observes durable state. A committed receipt takes the existing settlement-only path without another fetch or model request. Failed/uncertain extraction parks the job and retains the reservation. It is not permission to replay a paid attempt.

## Explicit configuration, no automatic activation

The optional capability has this shape inside `researchLimits`:

```ts
knownCompanyExtraction: {
  version: 1,
  model: '<exact reviewed Responses model>',
  maxCostMicros: 100_000,
  maxOutputTokens: 1024,
  maxInputBytes: 20_000,
  inputMicrosPerMillionTokens: 1_000,
  outputMicrosPerMillionTokens: 2_000,
}
```

The numbers above illustrate the schema, **not verified provider pricing or spending approval**. The capability's cost ceiling must fit within the job's existing `maxCostMicros`. Integer arithmetic checks a conservative token ceiling from the entire JSON request byte cap plus 1,024 overhead tokens, and the output-token cap, against the explicitly reviewed input/output rates. The request must fit that byte cap before HTTP. Review must establish that this byte/token bound and those rates cover the exact model; they are not inferred from its name. The full job reservation remains conservative when actual invoice spend is unknown. Review the model, bounded input/output costs and source scope before enabling this mode. A model name and cost assertion do not prove provider compatibility or enforce a provider-side billing cap.

Existing configurations omit this field and retain deterministic, model-free selected-page extraction. This change adds no Settings activation control, installed-app configuration, default provider call, budget increase or live migration. It is a main-process integration seam for a separately reviewed first-use configuration. Known-mode automatic `prepare`/`runNext` stay inactive; the delegated discovery/cycle coordinator explicitly refuses this desktop-only mode. Closed-Mac known-account enrichment is not implemented by this patch.

## Limits and acceptance

Mechanical quote matching is provenance, not semantic truth. A model can select an irrelevant or misleading exact quote. Whole blocks preserve qualifiers and negation rather than allowing selected substrings to drop them. Categories and business meaning still need evaluation and review. Published website text does not establish current portfolio accuracy, buying intent, a maintenance problem, decision-maker authority or consent to contact.

Parser bounds are 1,000,000 input bytes, 100 retained blocks and 12,000 characters per page. Overlong blocks are omitted intact with a truncation flag, not cut into misleading partial sentences. This remains a static parser, not a hard CPU/memory sandbox. Model input has an additional aggregate bound, and provider response reads are capped. Limits can result in a safely parked job, not a claim that all website facts were reviewed.

Local tests cover the production parser/adapter, protected-page composition and actual startup/preload/IPC/encrypted-database selected-account workflow with fictional HTTP/model boundaries. These are not a successful real-model, installed-app, hosted-worker or customer outcome. Production model compatibility, useful output across more sites, latency and cost require the next separately approved bounded qualification. No live retry or deployment follows automatically from a green test suite.
