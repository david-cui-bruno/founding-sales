# Gemini Ask integration — October 12, 2026

David chose Gemini after the [actual fixed-context comparison](https://github.com/david-cui-bruno/founding-sales/blob/codex/ask-model-comparison-551/docs/sourcing/ask-token-gemini-results-20261012.md). This source change belongs to #551. It does not merge the archival runners, enable a capability or lift the release hold.

## Implemented route

AI SDK6.0.303 uses pinned `@ai-sdk/google-vertex`4.0.212. Answering explicitly selects `provider: google_vertex`, `region: us`, a validated Google project ID and `modelVersion: gemini-3.8-flash`. The compact endpoint identity `vertex.us/<projectId>` fits the existing consent/database contracts while binding the actual fixed HTTPS US-jurisdiction endpoint and quota project. No schema migration is needed. Gemini uses LOW thinking with thought text excluded; reported reasoning tokens remain included in output accounting.

`FSS_CRM_CAPABILITY_ADAPTERS` installs adapters only. Vertex requires explicit bounded `agentLimits` and the existing provider key, access/data-handling versions and funding expiry. Bedrock configurations remain compatible; extraction and Titan embeddings retain independent routes. Nothing falls back between providers or grants owner consent at startup.

The ordinary runtime uses Google Application Default Credentials. It never invokes gcloud, reads installed desktop credentials or incorporates the diagnostic account's token. #552 still needs a supported runtime identity with authorized project prediction and quota access, current billing/funding and disabled owner settings followed by explicit scoped consent/Enable. The diagnostic's CLI permission evidence does not prove production authentication or promotional-credit eligibility.

## Tool protocol and lifetime

Each generation returns readonly tool requests; the host validates and executes them under current scope/access. Opaque provider metadata is bounded to64KiB per call and retained only in the running request's transcript. It supplies no evidence, identity or tool authority. A host-owned generation number keeps parallel calls in one assistant turn and their results together; different generations remain separate. The next SDK request preserves signatures without exposing them in answers, diagnostics, audits or saved history. Full input bounds include this metadata before another financial reservation.

Existing one-generation SDK execution, no transport retries, after-wait authorization, final-generation synthesis, cancellation, usage settlement, uncertain-dispatch conservation and source deletion stay in force. No database persistence or restart replay of generated protocol state is added.

## Verification and remaining acceptance

TDD first reproduced rejection of metadata-bearing calls at the registered worker, missing Vertex configuration/composition and missing signature replay at the SDK wire seam. Controlled regressions now cover the real Vertex encoder/decoder against fake HTTP, same-turn and different-turn signatures, total thought-token accounting, ambiguous503/no retry, cancellation and oversized state. Configured authenticated commands/registered workers with disposable PostgreSQL cover both routes' history, citations, follow-ups, narrowing/expansion, identity clarification, exact-only state, diagnostics and deletion.

These are deterministic integration/control observations. No actual Gemini call or production change occurs in these tests. The earlier5/5 generation candidates do not establish ordinary model→host tools→published answer usefulness, session continuity, representative reliability or activation. #551 remains open for a frozen approved actual configured-worker evaluation and independent output review. #552 retains runtime credentials, deployed configuration and release/Enable checks. Preserve all sending safeguards.
