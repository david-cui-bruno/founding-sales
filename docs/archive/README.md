# Archived documents

Everything under `docs/archive/` is a historical record: the design specs, execution plans, prototypes and guides that produced the code, kept for provenance. They describe the tree as it was when they were written. They are not the current plan, not an execution process to follow, and not a description of installed behaviour. The current documents are `README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/engineering/release.md` and the dated reports in `docs/engineering/`.

Moved here on 16 September 2026 (main `abfd259`):

- `superpowers/` (from `docs/superpowers/`): the Superpowers specs, plans and research note from 30 August to 10 September 2026, and the whole-product repair program that followed the 10 September adversarial audit. Paths quoted inside these documents as `docs/superpowers/...` now live under `docs/archive/superpowers/...`; the markdown links that leave this tree were updated so they still resolve. `superpowers/plans/2026-09-04-runtime-recovery-security-hardening.md` is still read by `test/releaseDocumentation.test.mjs`.
- `contact-workspace.md`: the daily-flow guide for the legacy person/prospect workspace (Today suggestions, Call, Email, Find contact info). Those routes are slated for deletion; the guide records how they worked.
- `2026-09-16-readme-product-notes.md`: the two behaviour sections removed from the README on 16 September (meeting-first reporting and the explicit workflow transition; the legacy local customer-discovery shortlist), verbatim.

The task reports that accompanied the Superpowers plans remain at the repository root under `.superpowers/`.
