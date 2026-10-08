# Human reply composer (#451)

Base: `67b75e42320edd240a02ce46fac9f619cc5914f0`. Scope and testing follow #441/#451 and David's approved parallel TDD seams. Sending belongs to #452.

## Agreed seams

- Public domain context/generation operations, real local PostgreSQL: observe assignment, exact conversation/envelope/fact revision, interruption, budget and replay behavior. Controlled model/time ports establish deterministic source races and zero mail dispatch; they do not verify live provider access.
- Authenticated API route with controlled model transport: observe session/client-version/request validation and typed readbacks. No body enters command receipts.
- Public desktop composer interactions inside the existing navigation draft provider: observe retained human text, stale source, exact revision review and late generation. This does not establish restart persistence or signed desktop publication.

## Boundaries

Use current shared approved answer blocks; FAQ/links remain exact free text in existing kinds. Pricing stays undefined unless separately approved. Human review applies only to the exact draft; it is neither shared fact approval nor send authority. Email Reply-To metadata is unavailable in the current retained header allowlist. RFC In-Reply-To is a message identity, never an address. Envelope options use verified current conversation routes, with no CC dispatch claim.

Only human-owned draft state survives navigation in the session-scoped DraftsProvider. Incoming/source/model context remains mounted state and existing mail body retention; no new body store, restart promise or send control is introduced. Routine automation, admission and calling remain off; original Shirley evidence and sending safeguards are unchanged.

## Vertical evidence

- Context: red missing public module, then green visible exact fact/envelope read with routine automation off.
- Manual answer: red reported only `thread_changed`; green recognizes same-thread verified-recipient evidence as `answered_manually`.
- Opt-out: red returned an authorized context after public suppression; green refuses `conversation_stopped` through the existing effective suppression authority.
