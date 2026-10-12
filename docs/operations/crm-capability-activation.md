# CRM capability configuration and Enable/Disable

Current merged source implements #581 ordinary authenticated owner consent and versioned settings. Production still has the dated schema88 release; the schema104 backlog remains held. This procedure describes the new source contract, not proof of deployment or authorization to enable it.

## Ordinary owner flow

1. Verify the deployed implementation and runtime adapter availability through normal readiness reads. Resolve release/bootstrap prerequisites using [lean release workflow](lean-release-workflow.md); configuration is not deployment.
2. Prepare disabled settings for the individual capability: metadata qualification, Gmail capture, bounded history import, extraction, answering or indexing. State actual owner/account/generation, sources, purpose, provider/data handling/model and allowance. Capture does not grant AI or history import scope.
3. Review the applicable actual evidence. Capture uses #549; extraction/progress uses #550; answering uses #551. Critical controls, actual model integration and useful reviewed labels support the approved provisional David-only tier, with representative-quality limitations visible. Codex performs the delegated usefulness review; David supplies genuine OAuth/data/spend decisions.
4. Use the normal authenticated Enable command with the current settings revision and explicit owner approval. The server persists the consent audit and refuses changed owner, account, generation, configuration or unsupported adapters. Unchanged ordinary releases preserve valid settings; material scope/provider/model/purpose/data-use changes and increased allowances require real renewed consent.
5. Observe durable enabled state, ordinary registered-worker operation and current readable output. Record which outcomes were actually observed. Disable remains available independently; cancel stops fresh work but cannot undo accepted provider requests.

Current source interfaces: `packages/domain/crm/capabilityAuthority.ts` owns read/activate/disable and owner verification; `capabilityVerifiers.ts` supplies runtime verification; `capabilityStartup.ts` validates adapter configuration. The desktop uses its existing capability operations. Use [module map](../agents/crm-ask-modules.md) for callers and tests.

## Runtime and recovery

Current membership, original-source access/deletion, account generation, cancellation, source hashes and paid/read reservations remain enforced before and after external waits. Known usage settles even if publication loses authority; unknown dispatch retains its allocation and is not blindly retried. Source erasure invalidates dependent content. Explicit Disable does not erase documentary consent history.

#549 readiness and #552 deployment/Enable share one ordinary-capture observation checklist. Independently passing selected-source/SQL functionality does not wait for native LinkedIn/OS tests. Applicable Gmail-backed outcomes still require actual Gmail evidence.

Preserve the production release hold, sending caps/ramp, original Shirley identity/cancelled follow-up, uncertain-send holds and admission/routine replies/calling off. Owner CRM approval never authorizes outreach. Use normal consent, never installed desktop credentials.

## History

[Schema88 privileged-receipt procedure and intermediate amendments](crm-capability-activation-history-schema88.md) are retained history. ADR0009's latest lean-owner amendment supersedes independent privileged per-release receipt provisioning. The source implementation does not itself attest rollout, consent or activation.
