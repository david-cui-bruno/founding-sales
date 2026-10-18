# Gmail sync, replies and separately consented CRM capture

Ordinary sending/reply synchronization and CRM business-original capture are different purposes. A connected mailbox does not authorize arbitrary body reads, historical backfill or hosted interpretation. Consult [owner setup](../operations/crm-capability-activation.md), the [CRM module map](../agents/crm-ask-modules.md) and [current state](../operations/current-state.md) for separate authority and dated readiness.

## Ordinary mail

`packages/domain/mail/` owns account/grant, sync, matching, history cursor, coverage, watch, recovery and effects. The API's integration callbacks authenticate provider events before scheduling work. Provider pushes are hints, not trusted message bodies or proof that synchronization completed. Cursor advancement and business effects must remain transactionally consistent and idempotent.

Matching must preserve workspace, mailbox generation and actual firm/contact association. Do not attach ambiguous correspondence to a guessed firm. Body access follows current scope rather than speculative fetching. Coverage gaps and disconnected/stale mailboxes remain visible holds. A successful watch renewal is not proof of complete conversation history.

Replies and explicit refusal/opt-out stop follow-up through the supported mail effects, policy and suppression paths. Deterministic evidence is not overridden by a model suggestion. A draft or classification never grants fresh sending authority. See [classification](classification.md), [sequences](sequences.md) and [sending](sending.md).

## CRM originals and extraction

Business selection and capture preserve incoming versus owner-Sent copy identity, source revision and account context. Personal, excluded or unresolved conversations do not become authorized by being visible in metadata. Capture requires exact owner-approved source/purpose scope and actual supported provider access. Interpretation needs separate model, data-handling and spending approval. An allowlisted configuration or historical authority receipt is not current consent or proof of a funded adapter.

Disable prevents new authorized work but cannot recall accepted external requests. Disconnect does not erase retained history. Source deletion erases affected Callie originals and dependent copied content while conserving recapture barriers; it does not delete Gmail originals. Historical backfill needs a separate bounded interval/read allowance and approval. Recovery metadata must not claim coverage that was not observed.

## Mailbox switching and recovery

Switches use current identity/generation and invalidate late UI/provider publication from the old context. Preserve known and uncertain provider attempts, existing sent-folder reconciliation and reply/stop history. Never reset counters or reuse old account consent to escape a refusal.

Use existing mail/API/worker integration tests with controlled transports and disposable PostgreSQL. Verify cursor races, duplicate events, switch/disconnect, stale authorization, source deletion and after-wait refusal. Live OAuth, Gmail body reads, capture and sending require their separate approval. Fixture success is not operational or model-quality acceptance.
