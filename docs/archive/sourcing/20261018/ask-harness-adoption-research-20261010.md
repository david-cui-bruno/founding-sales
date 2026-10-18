# Ask harness adoption research — October 10, 2026

Status: research and source inspection only. No packages installed, provider calls made, application source changed or capability activated. The release hold and sending safeguards remain. This note recommends components, not a measured performance winner.

## Recommendation

For Callie Ask, shortlist **Vercel AI SDK's tool loop and Pi's agent core** as reusable TypeScript components. Keep PostgreSQL, canonical conversation/evidence reads and application-owned usage/authority receipts. Prefer a bounded read-only investigation agent over adopting a general personal assistant, coding agent or multi-agent operating system. Use **LangGraph** when there is an actual need to checkpoint and resume a multi-stage Ask workflow across worker restarts; do not introduce a second persistence/control plane merely because the feature exists.

This is an integration-fit judgment. No source examined establishes that one harness is fastest or most accurate on Callie's questions. Model capability, retrieval tools, context selection and stopping behavior dominate the user-facing result; package feature breadth and GitHub stars do not establish performance.

## Method and pinned sources

Read official documentation and implementation files, including dependency manifests, provider calls and checkpoint deletion. Repositories were fetched read-only into `.scratch/ask-harness-research/`; nothing executed from those repositories. Current HEAD observations are UTC; the Hermes October 11 UTC observation is still October 10 in the user's America/New_York timezone. Branch documentation can change, so implementation conclusions below reference immutable commits.

| Project | Commit inspected | Source manifest/version | License |
|---|---|---|---|
| Pi, now earendil-works/pi (badlogic/pi-mono redirects) | ea448f454af474f3e2fe9733b331e17b0662f5d6 | @earendil-works/pi-agent-core 1.1.0; pi-ai 1.1.0 | MIT |
| Hermes | c57331677d7fc46298a7159cf3a650853f0966c5 | hermes-agent development source; manifest version 0.0.0 | MIT |
| LangGraph JS | f9cfb1e4d76bdfc250cd4763d59d59392adc6c51 | @langchain/langgraph 1.4.21 | MIT |
| Deep Agents JS | b448f220866bbb5d41924dfdbb1e0079c3b11838 | deepagents 1.14.2 | MIT |
| smolagents | 96f33faaf028479119ec8d34507b47694cf14e34 | 1.27.0.dev0 | Apache-2.0 |
| Vercel AI SDK | ba05943b69ad070558bb5bc912da99ec66d7d263 | ai 7.0.137; @ai-sdk/amazon-bedrock 5.0.113 | Apache-2.0 |

These are source-manifest versions, not a claim about an installed or published package selected for Callie. A lockfile and release-artifact review are still needed before adoption. License conclusions concern these repositories; transitive dependencies need their own normal review.

## Candidate matrix

| Component | What we could reuse | Fit with existing TypeScript worker | Persistence/deletion implications | Decision |
|---|---|---|---|---|
| AI SDK ToolLoopAgent or core generate/stream functions | Typed tools, streaming, loop stopping, per-step model preparation and lifecycle events; direct Bedrock provider | Strong: TypeScript, Zod-compatible schemas, Node >=22 fits our Node24 | Ordinary loop is not our durable evidence or usage ledger. Application owns history storage and deletion | First shortlist for a product-facing Ask runtime |
| Pi agent core | Provider-injected loop, typed tools, context reconstruction, before/after tool hooks, parallel/sequential execution, events, abort | Strong: Node >=22.19; TypeBox tooling needs schema adapter around existing Zod contracts | Core state is process-local; persistence is deliberately supplied by host. Avoid coding-agent session files and unrelated tools | Close alternative when exact loop control matters more than packaged UI plumbing |
| LangGraph core + optional PostgresSaver | Explicit state graph, node recovery/checkpoints, interruptions, streaming and retries | Good TS fit, but broader core/checkpoint/SDK dependency surface | Adds checkpoint tables and possibly independent stores; deletion must cover both and in-flight publication | Adopt only if durable resumable Ask runs justify it |
| Deep Agents | LangGraph-based planning, filesystem-backed context, summarization, subagents | TS, but layers LangChain/LangGraph/SDK/LangSmith peer dependencies over agent runtime | Files, summaries, subagent states and stores create more derived copies to invalidate | Not default for bounded CRM questions; reconsider for long research reports |
| Hermes AIAgent/API | Mature general assistant loop, searchable sessions, context compression, tool registry and API transports | Python process/service boundary rather than in-process TS library | SQLite/FTS sessions, profile memory and skills are separate storage domains | Study design patterns; do not adopt whole application for Ask |
| smolagents | Small Python ReAct loop, JSON tools or generated-code agent, callbacks/step limit | Requires Python boundary; existing Bedrock class differs from native tool calling | Memory/trajectories and executor artifacts must be integrated with deletion | Useful research reference; weaker first adoption fit |

The dependency-footprint comparison is qualitative from direct manifests; no installation, transitive package count, cold-start measurement or bundle-size measurement was performed.

## Pi: small core, substantial provider details

[Agent README](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/agent/README.md) and [loop implementation](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/agent/src/agent-loop.ts) expose `prepareRequest` before every provider request, `beforeToolCall` after validated argument parsing, `afterToolCall`, `finishTurn`, streamed events and cancellation. Tools can force sequential execution; the default batch execution is parallel. The Agent class awaits subscribed event handlers, whereas raw low-level event streams are observational and do not constitute an async persistence barrier. That distinction matters if a paid request or tool must be durably admitted before dispatch.

The [agent manifest](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/agent/package.json) depends on pi-ai and TypeBox. The [pi-ai manifest](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/ai/package.json) includes multiple provider SDKs, AWS Bedrock and telemetry. Small agent-core source therefore does not mean zero dependency footprint.

The [Bedrock implementation](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/ai/src/api/bedrock-converse-stream.ts) uses Converse streaming and propagates abort. Its client construction does not explicitly set `maxAttempts: 1`; its cache-retention resolver defaults to `short`. Those defaults require explicit treatment before combining it with Callie's no-blind-retry/no-cache acceptance contract. Most conservative integration: use the agent core with an application-owned stream function retaining fixed endpoint/model, admission and financial settlement, rather than silently switching provider semantics.

Pi's current package names differ from older @mariozechner references. Adoption should pin the inspected namespace/version rather than copy old examples.

## AI SDK: strongest product SDK shortlist, defaults require review

[ToolLoopAgent source](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/ai/src/agent/tool-loop-agent.ts) delegates to generate/stream functions with loop configuration and lifecycle callbacks. [Official loop documentation](https://ai-sdk.dev/docs/agents/building-agents) covers typed tools, structured outputs, streaming and configured stop conditions. We need a small explicit step budget, not its 20-step default, and tool handlers must perform authorization independently of descriptions/prompts.

[Retry preparation source](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/ai/src/util/prepare-retries.ts) defaults `maxRetries` to 2. Set 0 for provider attempts governed by our current uncertain-usage contract, then audit other retry layers. `onStepEnd` is useful for observed usage but does not alone prove an application durably reserved funds before dispatch or settled an interrupted stream. Streamed text should be provisional until citations/source versions are validated.

The [Bedrock provider implementation](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/amazon-bedrock/src/amazon-bedrock-chat-language-model.ts) prepares tools, parses reasoning/usage and handles streaming. [Provider docs](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock) describe model-specific behavior. Support at provider level is not a guarantee for every model/version. The inspected [provider manifest](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/amazon-bedrock/package.json) uses signing/fetch and eventstream packages rather than requiring Callie's existing AWS client surface; region, credentials, timeout and request-acceptance semantics need explicit mapping.

AI SDK does not require adopting Vercel hosting or a gateway. Prefer direct configured Bedrock if retaining that approved provider path. Do not interpret callbacks as equivalent to database transactions or checkpoint durability.

## LangGraph and Deep Agents: genuine recovery machinery, extra data surfaces

[LangGraph fault-tolerance docs](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) describe retries/timeouts and resume behavior. [Retry implementation](https://github.com/langchain-ai/langgraphjs/blob/f9cfb1e4d76bdfc250cd4763d59d59392adc6c51/libs/langgraph-core/src/pregel/retry.ts) and configurable retry predicates are inspectable. A timed-out paid model call can have been accepted; replay/checkpoint machinery cannot establish financial nonacceptance. Keep application operation IDs and unknown-attempt state even if using graph recovery.

The [PostgresSaver source](https://github.com/langchain-ai/langgraphjs/blob/f9cfb1e4d76bdfc250cd4763d59d59392adc6c51/libs/checkpoint-postgres/src/index.ts) implements `deleteThread` transactionally across checkpoint blobs, checkpoints and writes. This deletes one graph thread, not independent long-term stores, source copies or every summary derived from a removed conversation. [Persistence docs](https://docs.langchain.com/oss/javascript/langgraph/persistence) explicitly distinguish thread checkpoints from cross-thread stores. Application-level provenance/invalidation remains necessary.

[Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview) layers planning, filesystem context and delegation over LangGraph. Its [manifest](https://github.com/langchain-ai/deepagentsjs/blob/b448f220866bbb5d41924dfdbb1e0079c3b11838/libs/deepagents/package.json) has several required peers beyond the direct utility dependencies. Those capabilities are relevant to long research work, but are not automatically useful for finding promises in a firm history. Subagents and summarization can add model calls and source-derived state; no Callie latency/cost benefit is measured.

## Hermes: actual reusable boundaries versus whole assistant

[Architecture docs](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture) describe its Python core, tool registry and SQLite/FTS sessions. [Programmatic integration source](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/website/docs/developer-guide/programmatic-integration.md) exposes ACP, gateway JSON-RPC and HTTP/SSE. This is real embeddability, but via a separately owned application/service lifecycle. Profiles are not equivalent to Callie workspace/person/evidence contracts.

Current [provider resolver](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/hermes_cli/runtime_provider.py) includes `bedrock_converse`; the architecture diagram's three API modes is not exhaustive. Its [conversation loop](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/agent/conversation_loop.py) includes retry/fallback/compression orchestration. Do not import those default recovery decisions into a conserved paid-attempt contract without review. The [manifest](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/pyproject.toml) shows broad application dependencies and a current Python3.14-oriented packaging contract. There is no evidence here that running this whole application is lower effort than embedding a TypeScript loop for our narrow use case.

Useful patterns to borrow: visible tool progress, stable prompt tiers, explicit context compaction and searchable run history. Agent-created skills/memory should not become authoritative CRM claims or retain deleted source content by accident.

## smolagents: research ideas, provider caveat

[Agent source](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/src/smolagents/agents.py) supplies a ReAct loop, step limits, callbacks and code or JSON tool execution. Its [manifest](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/pyproject.toml) keeps many capabilities optional, including Bedrock/boto3. However, the [AmazonBedrockModel source](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/src/smolagents/models.py) removes `toolConfig`, uses its own message conversions and rejects `response_format`. Thus “supports Bedrock” does not mean it matches our desired native structured-tool protocol. Generated-code agents require an execution/sandbox surface which basic read-only Ask does not require. No generalized code-agent performance claim is used as evidence for our CRM workload.

## Actual Callie integration boundary

Current `apps/worker/src/providers/crmBedrock.ts` is a deliberately text-only Converse adapter. It sets AWS `maxAttempts: 1`, rejects cache usage, treats ambiguous failures as unknown accepted usage and requests exact extractive claims with no tools or inference. Its prompt and response surface cannot simply accept a tool loop. Existing domain answer validation also refuses unsupported/non-verbatim claim shapes.

A tool-using Ask requires an explicit contract revision: typed canonical reads, citation/source versions, contextual synthesis separately labeled from exact state, per-request usage reservations and settlement, bounded follow-up steps, cancellation, current-authority rechecks and final publication checks. No harness owns these domain guarantees for us. Preserve SQL exact state and evidence contracts; let the model decide which approved reads help answer.

Deletion must invalidate every copied passage, summary, checkpoint and cached answer dependent on the deleted source, and prevent a still-running request publishing it. Storing source references instead of durable raw tool-output transcripts reduces duplicate content, but does not remove in-flight race handling. This remains aligned with ADR0002/0006/0008/0009, not grounds to weaken them.

## Decision now and remaining uncertainties

A credible research-grounded architecture is **one bounded model-led read-only Ask loop, small domain tools, canonical PostgreSQL evidence, explicit source citations, streaming progress and application-owned durability/usage guards**. Shortlist AI SDK and Pi; LangGraph is the recovery-oriented alternative. No need to choose a general assistant framework, vector database, generated-code sandbox or multi-agent delegation before a demonstrated use case.

Research supports this shape and lets us narrow implementation choices. It cannot prove that a particular model/runtime meets our answer quality or latency targets. Before adopting: verify published artifact/lockfile, provider model tool behavior, streaming usage on cancellation, retry layers, authority/deletion race hooks and data-bearing telemetry defaults. Later workload acceptance should test those claims rather than search for a universal “best agent” leaderboard. We can do this with synthetic business scenarios first, without personal email or a large real customer corpus; synthetic results remain labeled as such.
