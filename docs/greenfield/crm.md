# CRM identities, routes and business history

A firm is an organization. A person exists independently of a firm; a contact is the person's operational association with that firm. Endpoints and routes are not identity or permission. Opportunities represent commercial initiatives, not conversations. These distinctions and their historical context are defined in the root glossary and ADRs.

## Authorization and locking

`packages/domain/crm/authorization.ts` defines the current mutation boundary: an administrator or the assigned salesperson may change the firm, while a merged firm is history and refused. System jobs use their explicit system scope. Commands load the current firm under the required lock before deciding, so reassignment cannot be overtaken by a formerly authorized actor. Reads distinguish ordinary operational fields from bodies, notes and private context.

Use existing `firms.ts`, `contacts.ts`, `routes.ts`, `pipeline.ts` and `merges.ts` commands. Do not add a parallel client-side permission system. The contracts and database constraints remain authoritative for allowed field values, route state, stage changes and refusal codes.

## Routes and evidence

An observed telephone number or email address is not necessarily associated with the intended office/person, and a usable route does not grant consent. Preserve provenance and the versioned route policy. Selected attachments, imported evidence and prepared briefs must retain original sources and uncertainty. A model interpretation cannot overwrite an original or manufacture a supported relationship.

Merges preserve operational history, source associations and conflicting evidence. They cannot silently choose a canonical value where the supported command requires human resolution. Stage events and audits remain historical records. Corrections add current truth without erasing the fact that an earlier action occurred.

## Conversations and work

CRM conversation originals, interpreted claims, commitments and Today progress are separate projections. Capture, extraction and outreach require different approvals. The [module map](../agents/crm-ask-modules.md) names the maintained boundaries. [Plain search](crm-surface.md) retains original passages and human work without generated answering.

Deletion is an explicit audited privacy workflow, not a firm merge, Disable or disconnected account. Preserve minimal suppression/recapture barriers and required business history while erasing private originals and dependent copied content through [retention](retention.md).

## Verification

Existing domain/API tests exercise assignment races, duplicate/ambiguous identity, route refusal, merge conservation, private reads and stage history using disposable PostgreSQL. Controlled evidence is not proof of a real office, reachable route or permission to contact someone. Consult [current state](../operations/current-state.md) for dated operational acceptance, not this source description.
