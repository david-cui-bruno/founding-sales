# Provider incident recovery (#445)

David approved the #441 public domain/worker/API seams, real PostgreSQL and controlled external/time adapters. This work uses `reconcileOutboundMessage`, `dispatchOutboundMessage`, mailbox sync/reconciliation handlers, and versioned sender standing reads. These expose persisted cooldown timing, unchanged-configuration revalidation, stops, lower caps and at-most-once fences. They do not prove live Gmail permissions, received authentication, reputation, production release or signed desktop distribution.

The first vertical slice is a Sent-search rate limit with a valid retry deadline: persist waiting, survive another caller/restart, make no provider call before the deadline, and revalidate by reading after it. Never resubmit the uncertain fence. Unknown classifications, missing/malformed deadlines, changed/unknown authentication/permission bindings and consequential reputation evidence stay held for established human revalidation/resolution. Ordinary recovery grants no sender permission or cap increase.

Contract coordination: `/outreach/senders/standing/v2` will keep the existing strict `SenderStanding` nested unchanged and add body/address/token-free incident metadata. Root owns shared contract exports, API registry and desktop integration. Migration0065/schema65 belongs to #445; notification work may stack0066 after the tested foundation commit. Incident records and their holds are retained operational history, including after prospect deletion, member departure and restore; a restored deadline never establishes fresh external safety evidence.

## Slice evidence

Recorded below as each approved public red→green cycle completes.

1. The Sent reconciliation tracer failed because `retryAt` was missing from the rate-limit answer. With migration0065 and the incident module, the same public test passes: an independent caller before09:05 makes no second search; at09:05 the original delivered message is observed, with one provider submission total. Recovery binds existing OAuth generation/token rotation, authentication checklist and permission revision metadata; clearing is limited to incident-owned holds. This first slice uses controlled Gmail outcomes; HTTP header propagation and broader dispatch/worker/lifecycle checks follow.
