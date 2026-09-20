# G3b: a search box is an oracle, so the matched fields are the visibility class

**Date:** 20 September 2026 · **Lane:** G3b CRM surface · **Spec:** 5.2, 7.2,
Appendix F

Appendix F gives a salesperson two views of a firm: everything, for the firms they
are assigned, and *firm identity, pipeline stage and dates, sequence status and call
outcomes without notes* for everybody else's. `readFirmForActor` implements that as
two types, so the narrow read has no field a note or an address could be in.

The specification does not say what search does with the same rule, and the obvious
implementation is wrong.

## The wrong implementation

Match the term against every field, then return the DTO the caller is entitled to.
The results are correctly redacted and the salesperson has still learned something
they were not entitled to: they typed a prospect's private email address, a firm came
back, and now they know that address belongs to that firm. The same trick reads a
colleague's contact list one name at a time, and their prospects' phone numbers one
number at a time, at roughly a hundred guesses a second.

That is the classic search-as-oracle leak, and Appendix F cannot prevent it, because
Appendix F is about what a response *contains*.

## What was built instead

The fields a term is matched against are the caller's visibility class:

| Match field | Any active member | Assigned salesperson, admin, system |
|---|:---:|:---:|
| `name` — the canonical firm name | Yes | Yes |
| `domain` — website, and `domain` aliases | Yes | Yes |
| `locality` — locality and region code | Yes | Yes |
| `alias` — `name` and `external_id` aliases | Yes | Yes |
| `address` — address line, postal code | | Yes |
| `contact` — a contact's full name | | Yes |
| `email` — an email route, and `email` aliases | | Yes |
| `phone` — a phone route, and `phone` aliases | | Yes |

The narrow set is exactly the fields `FirmIdentityDto` already publishes, so a
salesperson can find a colleague's firm by anything they could have read off the
screen and by nothing else. The wide set is decided per row, in SQL, by the same
predicate `decideFirmRead` uses — `assigned_user_id = actor` or admin — so the
decision cannot drift between the filter and the DTO.

Aliases are split across the two classes by `alias_kind` rather than being all one or
all the other. A merge turns a firm's former name into a `name` alias and its former
routes into `email` and `phone` aliases; if aliases were narrow, merging a firm would
quietly publish its routes to everybody in the workspace.

## Every hit says what it matched, and never what the match was

`SearchHit.matchedOn` is a list of field kinds — `['name']`, `['email', 'phone']` —
never the matching text. For the narrow class the text is the thing being withheld.
For the wide class the caller may read the record anyway, and sending the value
would mean deciding a redaction question in the search result shape as well as in the
DTO. One place is better than two.

## Search is not audited; export is

5.2: "Admin reads of message bodies, drafts, mailbox diagnostics, and exports create
access audit events." Search is not in that list, and exports are, so `searchFirms`
writes nothing and `exportFirms` writes an audit event every time.

The conservative reading would audit both. It was rejected for a specific reason: an
audit write turns every search into a transaction against the primary, and a person
using a search box types six searches to find one firm. The reads a search can reach
are the reads the caller may already perform one at a time — and opening the firm
*is* audited, by `firmReadIsAudited`. An export is different in kind: it removes a
copy of the data from the system, which is why the specification names it.

## The sequence-status filter

7.2 lists it among the filters and lane G8 does not exist, so there is no enrollment
table. The filter is answered from that fact rather than stubbed: `none` restricts
nothing because no firm is enrolled, `active` and `stopped` match nothing because no
enrollment exists. A test in `packages/domain/test/crm/search.test.ts` asserts that
`sequence_enrollments` does *not* exist and fails the moment it does, so the branch
cannot go on being wrong once it becomes wrong.
