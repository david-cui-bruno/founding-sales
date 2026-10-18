# Funnel facts

`packages/domain/funnel/facts.ts`, `kinds.ts` and `read.ts` retain event-derived business measurements. They are not a second authority for contacting people or interpreting private correspondence.

A fact belongs to a workspace and its actual business subject. Producers use the supported event identity and deduplication rules. Replaying an event must not count the same business action twice. A fact's kind, subject and occurrence time describe what was recorded, not a claim that a later provider effect happened. Read projections must preserve audience restrictions.

Current source producers, migrations and contract values determine which kinds exist. Historical facts may outlive the feature that created them. Removing booking automation, generated Ask, automatic email admission or recurring posting does not authorize dropping business records or rewriting historical counts. Conversely, a historical row does not mean the deleted producer still runs.

Corrections and withdrawal must remain explicit. A stale or withdrawn source cannot continue to imply a current positive result. The [retention](retention.md) workflow redacts personal content while conserving required historical/audit structure. Do not bypass it with a direct delete.

When changing a producer or report, exercise existing funnel and domain integration tests with duplicates, withdrawn source, cross-workspace data and access restrictions. Database fixtures prove event accounting, not live conversion, provider delivery or actual useful lead supply. Report measured outcomes with their scope and dates rather than equating jobs completed with successful selling.
