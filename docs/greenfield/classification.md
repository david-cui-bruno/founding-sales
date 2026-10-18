# Reply classification and confirmation

The reply classifier proposes a structured interpretation of an already authorized message. It does not choose whom to contact, grant follow-up permission or decide that an uncertain delivery succeeded. The authoritative rules are in `packages/domain/classification/`, `packages/domain/mail/effects.ts` and the retained reply/outreach modules.

## Authority boundary

Current mailbox, workspace, source access and conversation context determine what can be interpreted. Message text is untrusted input. A model label or quotation cannot replace a current policy check, a source citation or a human decision. Classification settings and adapter availability are distinct: a configured model does not prove that provider traffic is permitted or functioning.

Opt-out/refusal and reply-stop facts go through the existing mail effects and suppression paths. They must not depend on a generated draft being approved or sent. Unknown or unavailable interpretation remains visible rather than silently becoming a positive business result. The reply card separates the original, the proposed classification and supported confirmation actions.

## Paid work and privacy

Use the normal model transport and its configured access, data-handling and budget controls. Do not introduce a fallback provider or reuse a credential from another purpose. Preserve source/version and current authority checks across waits. Logs and errors must not expose bodies or private model outputs. Deletion and retention also cover cached/derived content, not just the original row.

A classification cache is not timeless evidence. Changes to the relevant source, configuration or model/prompt binding require the existing invalidation rules. Source completion and fixture quality are not evidence of representative live model usefulness.

## Integration and checks

The worker composition in `apps/worker/src/bootstrap/main.ts` selects the classifier and registers its handlers. The API and renderer consume the contracts, not provider responses. See the [reply integration map](../agents/replies-notifications-integration.md), [mail](mail.md) and [sending](sending.md).

Existing classification, reply and mail-effect tests cover refusal, stale context, duplicated work and stop behavior. For changes, exercise those public seams with controlled transport and disposable PostgreSQL. A passing fixture does not authorize a live mailbox read, reply or automatic outreach.
