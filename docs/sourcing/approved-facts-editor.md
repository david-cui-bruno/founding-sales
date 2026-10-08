# Shared approved facts editor — #450

## Approved seams

David approved the #441 testing approach and the parallel #450 implementation through these existing caller-facing interfaces:

- `OutreachSection` with `OutreachPorts`: visible editing, retained drafts, stale-version refusal, refresh/compare, explicit adoption of a current version and separate approval. Controlled ports model the remote application boundary; they do not prove a signed desktop publication or provider behavior.
- Public `saveAnswerBlock`, `approveAnswerBlock`, `retireAnswerBlock`, `listAnswerBlocks` and `readApprovedAnswerBlocks` commands/reads with real local PostgreSQL: workspace ownership, concurrent version changes and exact approved references. They do not prove production deployment or external sending/publication authority.
- Existing `readSocialDraftSources` with real local PostgreSQL: social drafting consumes the same exact approved product references and refuses superseded or retired references. It does not prove social publication permission; booking/material links are not social generation inputs.

## Scope

Reuse `packages/domain/outreach/facts.ts` and its immutable answer-block versions. Saving creates an unapproved current version; only a separate administrator action approves its exact text. Existing references become unusable after a version change or retirement. The editor retains typed text after a stale save and refresh, shows the current text for comparison, and requires explicit adoption of that version as the base before saving the retained draft.

FAQ text can use the existing kind and text fields (for example, a product question and answer in a product block). Booking and material links can be included in exact approved text. This does not add structured FAQ metadata, link discovery, URL policy changes or social support for every block kind. Social already has its own selected-kind and URL restrictions; recap consumption belongs to #456.

Pricing remains undefined unless separately approved. Unsupported new claims require explicit review/approval. Editing, saving, approval and retirement do not grant sending or publication permission. Automatic admission, routine replies and autonomous calling remain off; original Shirley receipts and operational gates are preserved.

## Verification record

Base: `be846f684a0a230db18effa2726130e3f42de262`; branch: `codex/450-approved-facts`.

- Editor slice 1: the new caller-facing interaction failed because Save remained enabled after a stale-version refusal. It passed after the facts panel required refresh, comparison and explicit adoption while keeping the typed draft; its successor remained unapproved.
- Editor slice 2: the new interaction failed because an unapproved draft had no Retire action. It passed after retirement became available for any current, nonretired version; the proposed pricing claim was never approved.
- Existing foundation characterization, green on first run: real PostgreSQL admitted exactly one of two concurrent edits, refused the stale writer and stale approval, kept the successor unapproved, enforced administrator/workspace isolation, returned exact approved FAQ/link text, and made shared/social readers refuse changed, unapproved and retired references. These checks verify inherited behavior; they are not claimed as new red/green domain fixes.

Checks passed on October 8, 2026:

- Full desktop suite: 1,576 passed, 29 existing skips; facts editor interactions: six included passes.
- Domain outreach/social suites: 117 passed across 21 files, including five facts tests with real local PostgreSQL.
- Outreach API suite: 11 passed; existing browser route-navigation test: one passed.
- Repository `typecheck:greenfield`, lint, secret scan and diff whitespace check passed. Secret scan reported zero findings in history and local context.

The editor and shared-reader scope is source-complete using the existing exact-text representation. No fact schema, kind, shared contract or social URL policy change was required. Structured FAQ metadata, special link authoring/validation and new downstream permission are not claimed. Social generation keeps its existing product/pricing selection; booking/material link consumption is available through the shared reader, not added to social generation. Recap use is tracked in #456; future human reply consumers can reuse the same reader.

No production read or mutation, sending-control change, provider call, deployment, PR publication, signed desktop build or external publication occurred. The scope does not alter the original Shirley submission receipt, admission activation gates, targeting, budgets, ownership, stops, cadence, caps or uncertain-submission fences. Integration and exact integrated-head checks remain the coordinator's responsibility.
