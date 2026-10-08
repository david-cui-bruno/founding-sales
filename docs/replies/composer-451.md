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
- Generation: red missing public operation; green bounded plain-text suggestion, exact references, mandatory human review and one paid attempt with zero Gmail sends.
- Sending hold during generation: corrected fixture first established a real `email_send` hold; red returned an obsolete suggestion, green binds applicable hold evidence into the source revision.
- Transport: red missing adapter; green uses only the existing configured Bedrock Haiku route, bounded output and token-priced credit reservation.
- Unsupported generated price/commitment: red returned invented offer bytes, green rejects explicit uncited offer/promise/capability/link patterns. This bounded backstop is not semantic grounding proof; every draft requires human review.
- API: red missing route; green authenticated strict context reads and current-client generation refusals. Generation uses the desktop's accepted/refused command envelope without retaining prose in receipts.
- Desktop: red missing composer; green retained text across navigation with visible envelope/thread/facts and no send control. Red missing refresh/adopt/review behavior; green preserves stale text and invalidates exact review on edits. Red missing suggestion control; green keeps late suggestions separate until explicit adoption. Red missing envelope/fact selection; green validates changed choices as new context with fresh review. Red retired-reference refresh could not expose current context; green compares current approved choices beside retained stale text before explicit adoption.
- Recipient identity: red exposed a historical mailbox account address as a prospect CC option; green excludes current and historical workspace author identities, and excludes multiply-associated address options.
- Booking context: red kept the same source revision after a public Cal.com reschedule; green binds bounded current booking state/times, existing plan/opportunity control metadata and human confirmation identity. Red omitted booking/envelope grounding from the model request and meeting context from the editor; green supplies and shows them without appointment controls.
- Internal forward: after a valid public matched-body fixture, red permanently refused the retained latest incoming question merely because an internal outgoing forward was newer. Green changes the source revision while retaining that question; only same-thread and verified matched-recipient answer evidence resolves it.
- Session interruption: after correcting the fixture's match authority and single mailbox ownership, red returned accepted prose after public device revocation during the model call. Green reauthenticates the same workspace/user/session/device/role before reservation, before the call and after the result; declined uncalled reservations use the existing caller-owned release outcome.
- UI interruption: red left suggestion preparation permanently disabled after refreshing an in-flight request; green discards that late result and retains an editable draft. Red exposed an unknown-result code; green gives plain-language guidance and preserves the original command identifier across navigation.

Additional safeguard characterizations pass at the agreed seams: separate PostgreSQL sessions admit one paid attempt for a concurrent command; unknown results cannot retry a paid attempt; existing credit ceilings and research holds refuse generation; retired facts, mailbox revocation and reassignment withhold obsolete prose; ambiguous matches require explicit selection; other workspaces receive no context; the assigned human sees only approved catalogue entries; classification cleanup leaves human prose intact while an identity change clears it.

Final owned checks: 19 real-PostgreSQL domain tests, four authenticated API route tests and ten public component tests pass. Contracts, domain, API and desktop typechecks, owned-file lint and the repository secret scan pass. The coordinator owns the merged application wiring and full integration gate.

## Current capability and release limits

The current API task has no Bedrock inference grant or transport configuration. Root owns optional injection of an already approved configured transport; absent capability truthfully returns `generation_unavailable`, while manual drafting remains available. No permission, environment or budget expansion is part of this ticket. Controlled transport demos do not prove live generation access. Backend deployment and signed desktop publication remain separate.
