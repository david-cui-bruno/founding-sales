# Identity, sessions and workspaces

The API authenticates the person and derives their workspace membership, role and device/session context. The web app does not choose its own authority. Current implementations live under `apps/api/src/auth/`, the identity/session routes and the domain workspace-scope modules. CRM authorization is separate from sign-in.

## Current authority

A successful sign-in does not authorize every action, private source or firm. Mutating commands enforce active membership, current role/assignment and their own capability/purpose checks. Private reads also recheck access. Preserve the authenticated session's client-version binding for installed-client compatibility. Do not infer a person's identity from an endpoint or confuse a firm with an authentication account.

Session/device changes and mailbox switches invalidate identity-scoped UI state. A late response from the old identity or generation must not publish into the new person's view. Refused, expired or unavailable authentication keeps controls unavailable instead of falling back to a shared identity. Never copy tokens or private draft bodies into logs.

## External accounts

Google mailbox connection, LinkedIn account connection and a Callie session are distinct authorities. Connecting an external account is not consent to capture messages, interpret originals, invite/message people, publish posts or send email. Gmail owner setup and consent are described in the [existing procedure](../operations/crm-capability-activation.md). No instruction here grants a provider scope or changes an account.

## Operational boundaries

Use the ordinary sign-in and session APIs. Do not repurpose installed desktop credentials for diagnostic or operator work, fabricate an authenticated session, or reset a password. Current release, credential and approval rules remain in AGENTS and [current state](../operations/current-state.md).

Existing API/session, cross-workspace and web identity-generation tests cover sign-out, changed membership, stale callbacks and private visibility. Fixtures do not establish a live OAuth grant or actual installed account connection. Source implementation and deployment metadata are also not owner consent.
