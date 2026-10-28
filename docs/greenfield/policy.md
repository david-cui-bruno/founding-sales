# Calling eligibility, holds and outcomes

The server decides whether a particular actor may call a particular current route. The web app displays this decision and supported refusals; it does not reconstruct a weaker parallel policy. Main boundaries are `packages/domain/dial/`, `packages/domain/policy/` and the shared contracts.

## Dial authorization

Current firm ownership/membership, suppression, applicable holds, route version/association, calling identity, personal state posture and recipient-local calling window all matter. A usable phone route is not permission. A saved calling number is not proof that it matches a configured provider identity. Dial tickets are bounded authority for their actual subject and must be checked again when consumed.

Caller setup and postures are editable through their existing authenticated forms. State rules require genuine personal confirmation, not an agent-created acknowledgement. Unknown geography/time zone, expired authority or a changed route must remain refused or held as defined by the contract. No setup save authorizes autonomous calls.

## Holds and stops

Holds have explicit subject and blocked-action semantics. Workspace, firm, owner and channel are not interchangeable. The current assigned owner is not necessarily the requester's identity, and an unrelated owner's pause must not disable every firm's actions. Use `holds.ts`, `pauses.ts` and the dispatch gate rather than inventing blanket client rules.

Stop facts and work dispatch are serialized so a committed stop is observed at the next applicable boundary. Disable cannot undo an external action already accepted. Keep uncertain attempts and actual costs. Email, call and research channels remain distinct; cross-channel history and refusal/suppression still apply where their policy requires them.

## Outcomes and follow-up

Logging a reached call outcome stops an old active sequence. Recording the exact permitted follow-up is a separate decision. Agreed sequences attempt the specified enrollment, while a single-email permission requires explicit matching one-step enrollment. An outcome label or source transcript alone never authorizes arbitrary follow-up. See [calling](calling.md) and [sequences](sequences.md).

Correcting outcomes must preserve original history, stop/suppression facts and current permissions. Do not reopen cancelled work by rewriting the visible outcome. Human callback tasks and scheduling retain their actual time-zone/calendar rules.

## Checks

Use existing dial/policy, call-outcome and sequence tests with disposable PostgreSQL. Exercise reassignment, stale route/ticket, applicable versus unrelated hold, refusal and outcome correction. Rendered controls and tests are not real call acceptance or legal advice. Consult the protected [suppression](suppression.md) and [sending](sending.md) instructions for those independent safeguards.
