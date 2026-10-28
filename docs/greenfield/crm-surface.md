# CRM views, import/export and plain search

Firms, people, contacts, routes, opportunities and conversation sources are distinct records. Their relationships do not grant outreach authority. See the root glossary and [CRM rules](crm.md). Current capture/search/deletion ownership is summarized in the [module map](../agents/crm-ask-modules.md).

## Read and edit boundaries

The API derives scope from an authenticated session. Firm identity and operational state have different visibility from message bodies, private notes and source content. Current assignment/membership and source access must be checked at the read or mutation boundary, not inferred from a cached card. Mutations re-read current rows under the appropriate locks and return closed contract refusals.

The web selling journey uses these contracts; complete record preparation remains a web product gap. See the feature map for actual navigation. UI affordances must stay unavailable or read-only when authentication, server authority or connectivity cannot establish that an operation is allowed. Stale writes require fresh review, not a blind replay.

## Ask is record search

`packages/domain/crm/ask.ts`, `askRecords.ts`, `askCorpus.ts` and `askOpenTasks.ts` implement bounded exact state, names, keyword passages and retained human tasks. Source text never supplies SQL. There is no generated-answer, embedding, vector/index or answer-action creation pipeline. Historical human tasks remain readable/completable with current source access. Installed1.0.51 compatibility is handled by the API's `askCompat` contract, not by restoring deleted capabilities.

Search results disclose scope, coverage and truncation. A missing keyword result is not proof that an event never occurred. Original passages remain source material, not verified claims or permission to act.

## Import/export

Import previews and commits are distinct. A preview writes no business records, and a commit re-derives the applicable decisions against current state. Duplicates and identity ambiguity require the supported reconciliation path, not guessed attachments or silent canonicalization. Exports containing business/private data are access-controlled and audited. Preserve safe CSV presentation and keep private exports out of commits and public artifacts.

## Checks

Existing API CRM/search/import/export and web component tests are the integration seams. Cover assignment changes, private-field visibility, stale input, duplicate commit and source deletion. Retained historical-data erasure is mandatory even though generated Ask was removed. See [retention](retention.md) and the map for exact privacy seams. Local tests do not prove hosted UI acceptance or authorize production data reads.
