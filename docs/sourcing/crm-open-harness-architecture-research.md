# Open harness architecture research for Callie Ask

Research date: October 10, 2026. Source inspection only; no harness installed, model called, adoption selected or activation changed.

## Question and finding

Can a capable model with a small tool surface answer CRM questions without a bespoke reasoning pipeline? These harnesses implement that pattern. They also contain explicit loop, context and execution controls: "tools around the model" is an architecture, but it still requires application-owned contracts. None of their examples or benchmarks establishes Callie sales accuracy.

Compare three approaches on the same cases/model/tool data: selected whole-thread context in one call; application keyword retrieval followed by one call; model-directed iterative tool retrieval. Harness choice is a separate axis from retrieval choice; any loop can use SQL, keywords or vectors as a tool.

## Verified repositories and pinned code

Search surfaced multiple forks. The official identities verified here are NousResearch/hermes-agent, earendil-works/pi (badlogic/pi-mono redirects there), and huggingface/smolagents. Pinning records the inspected revision, not a recommendation to install it.

### Hermes Agent, Nous Research

Inspected revision `c57331677d7fc46298a7159cf3a650853f0966c5`.

The Python embedding guide exposes AIAgent, toolset allowlists, persistent-memory disabling and iteration limits. It instructs callers to make a new agent per thread/task, and recommends lower iteration counts for simple Q&A. This is evidence that Hermes can host a bounded tool loop; the generous defaults are not suitable Callie budget decisions. [Pinned embedding guide](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/website/docs/guides/python-library.md)

MemoryManager integrates provider hooks and gated tool exposure. This supports modular memory, but does not imply its memories are authoritative customer facts. Callie should retain canonical source versions, corrections and deletion propagation separately from model-written memories. [Pinned memory manager](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/agent/memory_manager.py)

The repository has a compaction evaluation harness with controlled transcript fixtures and reported scorecards. These evaluate its context-compaction choices, not Callie promise detection or CRM retrieval. Borrow the practice of testing information retention, not the reported score as product proof. [Pinned compaction evaluation](https://github.com/NousResearch/hermes-agent/blob/c57331677d7fc46298a7159cf3a650853f0966c5/evals/compaction/README.md)

### Pi, earendil-works

Inspected revision `ea448f454af474f3e2fe9733b331e17b0662f5d6` through the redirected official badlogic/pi-mono API endpoint.

Pi exposes a reusable agent loop, context transformation, tool execution modes and before/after tool-call hooks. A beforeToolCall hook can block a validated call. Useful inference: a small TypeScript Ask loop can integrate the existing authenticated product reads without adopting a whole coding-agent application. [Pinned agent package](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/agent/README.md), [pinned loop implementation](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/agent/src/agent-loop.ts)

The coding-agent security documentation explicitly separates model behavior from OS isolation: project trust and watching transcripts are not security boundaries, and enabled tools operate with available process permissions. Callie Ask should expose scoped business reads, not inherit local shell/file privileges. [Pinned security guidance](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/coding-agent/docs/security.md)

Its session/context compaction documentation and implementation are relevant to long investigations, not evidence that we need persistent Ask sessions from day one. [Pinned compaction docs](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/coding-agent/docs/compaction.md), [session manager](https://github.com/earendil-works/pi/blob/ea448f454af474f3e2fe9733b331e17b0662f5d6/packages/coding-agent/src/core/session-manager.ts)

### Smolagents, Hugging Face

Inspected revision `96f33faaf028479119ec8d34507b47694cf14e34`.

The library offers both model-written Python CodeAgent and conventional ToolCallingAgent. Its memory records planning, execution and errors, with callbacks for context changes. This provides a useful contrasting experiment: normal typed tool calls versus programmatic composition, rather than assuming every agent must execute arbitrary code. [Pinned README](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/README.md), [agent implementation](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/src/smolagents/agents.py), [memory tutorial](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/docs/source/en/tutorials/memory.md)

Its maintainers explicitly state that LocalPythonExecutor is not a security sandbox and recommend isolated backends for untrusted code. A Callie read-only tool experiment does not need code execution; introducing it would need a demonstrated task benefit and a separate execution boundary. [Pinned security policy](https://github.com/huggingface/smolagents/blob/96f33faaf028479119ec8d34507b47694cf14e34/SECURITY.md)

## Research questions to answer with Callie experiments

1. Does iterative retrieval reduce unsupported answers or merely add latency/tool calls compared with complete relevant threads?
2. What is the smallest effective read surface: resolve person/firm, exact current state, search evidence, open thread, read coverage?
3. Can the model distinguish tentative offers, explicit commitments and quoted historical messages without extra classification pipelines?
4. Which context strategy preserves attribution/corrections best when irrelevant evidence and conflicting sources increase?
5. Do vectors improve paraphrase recall enough to justify indexing and deletion complexity?
6. What limits on calls, tokens, wall time and returned evidence prevent loops while preserving useful partial answers?
7. Can a follow-up reuse context safely after source deletion or corrections? Does it need durable checkpoints at all?
8. What is the gain from code-mode or delegation over plain business tools on these tasks?

## Interpretation and next comparison

No popularity, star count or generic agent benchmark is treated as demonstrated CRM performance. Harness-Bench explicitly studies harness effects across models in realistic agent workflows; its task/model envelope must be inspected before using numerical conclusions, and its results would still not measure Callie. [Primary paper](https://arxiv.org/abs/2605.27922)

Keep storage/jobs/evidence contracts while evaluating the reasoning layer. Start the tool-loop candidate with read-only, application-authorized business tools; canonical state remains in PostgreSQL. Record answers, source support, attribution, coverage, tool traces, cost and latency for all three approaches. Use synthetic cases as development evidence; do not relabel them as representative customer evidence or a sealed holdout. Adoption, production release and capability activation remain separate decisions.
