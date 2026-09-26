# G14: deletion removes what it can and redacts what it must

**Date:** 20 September 2026 · **Lane:** G14 retention · **Spec:** 10.3, 10.2, 5.2

## The sentence

> A documented deletion workflow removes ordinary personal and correspondence data
> while retaining a minimal normalized suppression tombstone where needed to prevent
> renewed contact.

It does not say the firm row goes. It says *ordinary personal and correspondence
data* goes. The difference turned out to be forced by the schema rather than
optional.

## Why the rows cannot simply be deleted

Five tables have `DELETE` revoked from both application roles: `audit_events` and
`suppression_events` (migration 0001), `opportunity_stage_events`,
`record_merge_events` and `crm_domain_events` (migration 0004). Each of them carries
a foreign key onto `firms`, `contacts` or `opportunities`.

So a deletion that removed the firm row would have to remove that history first, and
it is not allowed to. Nor should it be: section 10.3's first row keeps "firms,
contacts, opportunities, stages" as Callie business history, and 5.2 makes the audit
trail append-only deliberately. A deletion workflow that could erase its own audit
trail is not a deletion workflow.

## Decision

**Remove what nothing append-only references.** The handles (`email_addresses`,
`phone_routes`), the correspondence (`mail_messages` and everything migration 0009
cascades from it), the evidence, the call history, the callbacks, the dial tickets,
the derived Today rows, the aliases and the research suggestions.

**Redact what it does.** `contacts.full_name` becomes `[deleted]`, its title and
LinkedIn URL become null, its status becomes inactive. For a firm deletion,
`firms.name` becomes `[deleted]` and the website, address line, locality and postal
code become null. The rows stay, so the stage events and merge events that point at
them stay readable, and nothing in them names a person.

`[deleted]` rather than null because `firms_name_present` and
`contacts_full_name_present` require a non-blank name, and widening a CRM constraint
this lane does not own to allow an empty one would have been a worse trade than a
placeholder somebody can read.

**Retain and say so.** The preview returns a `retains` map beside `removes` and
`redacts`, so an admin approving a deletion is told what will still be there rather
than discovering it later.

## The preview hash

The preview stores counts and returns handles; the commit presents the hash the
preview returned, and the command recomputes it. Two comparisons, not one: the
presented hash catches a client approving somebody else's preview, and the stored
one catches the world changing since it was shown. A new contact or a new message
arriving between preview and commit makes them disagree and the commit is refused
rather than deleting more than was approved.

The handles are hashed and returned but never stored. A deletion record that quoted
them would keep a copy of exactly the data it deleted.

## What this gives up

A firm's *existence* survives a deletion, as a row named `[deleted]` with a creation
date and a pipeline history. For a data-subject request that is the right answer —
the personal data is gone and the business record of "a company we spoke to" is
Callie's — but it is not erasure of the record, and the product should say so.

If a future requirement needs the row itself gone, it needs a migration that makes
the append-only foreign keys nullable, and that is a decision about the audit trail
rather than about retention.
