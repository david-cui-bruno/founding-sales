# Decisions

**From 25 September 2026, a decision is a changelog line unless it changes an interface or a safety rule: one fragment file under [`docs/greenfield/changelog/`](../greenfield/changelog/), which [`changelog.md`](../greenfield/changelog.md) is generated from.** An interface is a route, a wire contract, a command or script someone runs, a schema, or a file another lane reads. A safety rule is anything that decides whether the product sends, dials, deletes, restores or deploys. Those still get a document here, named `<lane>-<what was decided>.md`, saying what was decided, why, and what it gives up.

The documents written before that date are history. They stay as they were written: code and other documents cite them, and a later document or changelog line supersedes one rather than editing it.
