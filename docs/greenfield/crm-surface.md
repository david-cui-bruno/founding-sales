# The CRM surface: search, import, export, and the windows

Specification revision 3, sections 5.2, 7.2, 8.1, 14.1 and 14.2, and Appendix F and
Appendix G 7, 8, 37 and 38. `docs/greenfield/crm.md` is the data and the rules for
changing it; this is how a person finds it, gets it in, gets it out and looks at it.

## The short version

Search matches a fragment against the fields the *caller* may see, never against
everything and then filtered — because a search box that finds a firm by a colleague's
prospect's email address has told you that address is at that firm. Import is two
phases: a preview that writes nothing and a commit that runs one ordinary command per
row. Export is a search somebody decided to keep, at the width the read matrix gives,
audited once. The windows show what they were sent and disable what cannot be done.

## Where everything is

```
packages/domain/db/migrations/0005_search.sql  pg_trgm and the indexes
packages/domain/crm/search.ts                  the term, the filters, the match fields
packages/domain/crm/import.ts                  the CSV parser, the preview, the commit, Add firm
packages/domain/crm/exports.ts                 the rows and the audit event
packages/domain/crm/firmPage.ts                opportunity, stage history, holds
packages/contracts/src/crmSurface.ts           the wire contract
apps/api/src/routes/{search,import,addFirm,export,firmPage}.ts
apps/api/src/routes/modules.ts                 which router owns which paths
apps/desktop/src/renderer/firmWorkspace.ts     the CRM window's entry point
apps/desktop/src/renderer/firmWorkspaceView.ts what it shows, as a pure function
apps/desktop/src/renderer/{firmPage,contactsEditor,pipelineBoard,firmMerge}.ts
apps/desktop/src/renderer/{addFirmForm,importScreen,captureView}.ts   Add firm and Import (g84)
```

## Four rules a reader should carry

### 1. The matched fields are the visibility class, not the results

| Match field | Any active member | Assigned salesperson, admin, system |
|---|:---:|:---:|
| `name`, `domain` (website and domain aliases), `locality`, `alias` (name, external id) | Yes | Yes |
| `address`, `contact`, `email`, `phone` (and email/phone aliases) | | Yes |

The narrow set is exactly what `FirmIdentityDto` publishes, so a salesperson can find
a colleague's firm by anything they could have read off the screen and by nothing
else. Every hit reports `matchedOn` — field kinds, never the matching value.
`docs/decisions/g3b-search-visibility.md` has the argument.

### 2. A preview writes nothing, and the commit re-derives it

`POST /import/preview` is a read. `POST /import/commit` takes **the file again**, not
the preview: a preview is a value the client holds, and a client that could post an
edited one would be posting rows the server never validated. The server re-previews
the same bytes and commits the rows the caller named, each under its own command id.

One row is one `runCommand`, so one row is one receipt, one payload hash and one
transaction. A row whose contact fails takes its firm back with it; the rows either
side still commit; and a retry of the whole file replays what landed and attempts what
did not. That is Appendix G 38's "atomic per-row commands" and "partial failures" in
one mechanism. Because the hash is over the *row*, editing a line and retrying under
the same command id is `command_payload_mismatch` rather than a silent second import.

Every lookup is workspace-scoped, so an external id that names a firm next door is
`create` here, in the same words as an id that exists nowhere.

### 3. An export is audited; a search is not

5.2 names exports among the reads that "create access audit events", and does not name
searches. `exportFirms` writes one `export.firms` event carrying the row counts, the
filters used and whether there was a term — never the term, which may be a prospect's
address. A refused export writes nothing, because nothing left the system. The
reasoning, including why auditing search was rejected, is in
`docs/decisions/g3b-search-visibility.md`.

There is no CSV export. A flat file has one set of columns and Appendix F has two
visibility classes; a CSV of both would need an `address_line` column blank for some
rows and populated for others, which is the "one type with a filter" shape the two
DTOs exist to avoid, re-created in the output format.

### 4. Reads that carry a person's data are POSTs

`/search/firms`, `/export/firms` and `/crm/firm-page` are POSTs although two of them
write nothing. A search term is a prospect's name, address or telephone number, and a
query string is written to the load balancer's access log on the way in, where no
amount of response redaction reaches it.

## The endpoints

| Path | Who | What |
|---|---|---|
| `POST /search/firms` | any active member | term and filters; hits at the caller's width |
| `POST /crm/firm-page` | any active member | one firm; detail adds opportunity, stage history, holds |
| `POST /import/preview` | admin | per-row outcomes and issues; writes nothing |
| `POST /import/commit` | admin | the file again plus one command id per row |
| `POST /crm/firms/add` | any active member | one firm and optionally its first contact; one command (g84) |
| `POST /export/firms` | any active member | typed redacted rows; one audit event |

Filters are shared by search and export: `owner` (a member, or unassigned),
`stageKey`, `sequenceStatus`, `holdReasonCode`, `routeEligibility`, `activeSince` and
`activeUntil`. An unknown stage key is `stage_unknown` rather than an empty answer —
"no firms are at that stage" and "there is no such stage" are different facts.

`sequenceStatus` reads `sequence_enrollments`, which lane G8's migration 0012 created.
`active` is a live enrollment for the firm, `none` is the absence of one, and `stopped`
is the absence of a live one together with the presence of a stopped one — a firm whose
sequence finished last month is one nobody is contacting today. Until 0012 it was a
stub, and the test that said so failed the moment the table appeared, which is how it
stopped being a stub.

`activeSince`/`activeUntil` compare against the latest of the firm's own `updated_at`,
its last stage event and its last evidence item. Message and call activity join that
expression when their lanes land.

## The CSV

This is the format the Mac's **Import firms** screen reads (Firms window, **Import CSV**,
admins only), and the one `POST /import/preview` and `POST /import/commit` take.

**One row per contact.** A spreadsheet of prospects has a line per person, so the
firm's columns are repeated on each of that firm's lines. A header row is required; the
columns may come in any order, and all of them are optional except `firm_name`:

```
firm_name, website, contact_name, contact_title, contact_email, contact_phone,
time_zone, address_line, locality, region_code, postal_code, external_id, owner_user_id
```

For example:

```
firm_name,website,contact_name,contact_title,contact_email,contact_phone,region_code
Birch Test Advisors,birch.example.test,Lee Placeholder,Principal,lee@birch.example.test,401 555 0131,RI
Birch Test Advisors,birch.example.test,Pat Placeholder,Associate,pat@birch.example.test,,RI
Cedar Test Partners,cedar.example.test,,,,,MA
```

That is two firms: Birch with two people, and Cedar with nobody yet.

A header is matched without regard to case, and a space or a hyphen in it reads as an
underscore, so `Contact Email` is `contact_email`. A `website` may be a bare domain
(`birch.example.test`) or a full address; it is stored as `https://…`. `time_zone` is an
IANA name such as `America/Chicago`; without one the firm's zone comes from its postal
code or state where it can, and calls to it wait until it has one. `region_code` is two
letters. A ten-digit number is taken as North American and eleven digits starting with 1
as the same; anything else needs its `+`. A guess would be dialed at a stranger.

**A whole file is refused** before any row is read when it is empty, has a column this
list does not name (`csv_column_unknown`, naming the header as written), names a column
twice (`csv_column_repeated`), has a line of the wrong width (`csv_row_width`, naming the
line as a spreadsheet counts it, the header being line 1) or has more than 2,000 rows. A
file that half-parses is a file somebody exported from the wrong system. The answer is
409 `{ "status": "refused", "reason": "csv_column_unknown", "column": "Notes",
"rowNumber": null }`, and the screen says *The column “Notes” is not one Callie imports.*

**Each row is one of four outcomes**, with the issues that made it so:

| Outcome | When |
|---|---|
| `create` | a firm nobody has yet, with this row's contact if it has one |
| `attach` | a firm already here, or created on an earlier row, and a contact new to it |
| `duplicate` | the row adds nothing: its contact is already at that firm, or it names only a firm that is already here |
| `invalid` | a field is wrong; nothing from the row is imported |

**Matching, in order.** A row's firm is the workspace's firm with the same `external_id`,
else the same website domain (`www.` ignored), else the same name (case and spacing
ignored) — but a name match is not taken when both have websites and the domains differ.
A row that matches two firms here is `firm_ambiguous`: merge them first. Failing all of
those, a firm an earlier row of the file creates, by domain and then by name. A contact is
the same person as one already at the firm by email address, or by name when the row has
no email. Only the workspace is searched: a firm in another workspace is never a match.

**Invalid beats duplicate**, because a row that is both should be shown the fault it can
fix. A bad email address or an unparseable number makes the whole row invalid rather than
importing the firm and dropping the route: a route silently missing is a firm nobody can
contact and nobody knows why.

**A refused row names its row and its field.** Every issue is `{ column, code }` — for
example `{ "column": "contact_email", "code": "email_invalid" }` on row 4 — and the screen
shows it under the row as *Email: Not an email address.* The codes are `firm_name_missing`,
`website_invalid`, `region_code_invalid`, `postal_code_invalid`, `email_invalid`,
`phone_invalid`, `contact_name_missing` (a title, email or phone with no name),
`owner_unknown`, `time_zone_invalid`, `too_long`, `firm_ambiguous`, `duplicate_in_file` and
`duplicate_in_workspace`.

**The commit decides again.** Import commits the rows the preview marked `create` or
`attach`, in the file's order, each under its own command id. Each row is decided again
against the workspace as it is at that moment, so a contact somebody added by hand since
the preview comes back refused, with its row and column, rather than added twice:

```
{ "rowNumber": 2, "status": "refused", "replayed": false, "reason": "duplicate_in_workspace",
  "firmId": null, "column": "contact_email", "outcome": null }
{ "rowNumber": 3, "status": "accepted", "replayed": false, "reason": null,
  "firmId": "…", "column": null, "outcome": "attached" }
```

A row is one transaction: a row refused after its firm was written takes the firm back
with it. Pressing Import again on the same preview replays what landed.

**What an imported firm is.** It is assigned to the row's `owner_user_id`, or to the
admin who imported it — dialing needs an assignee. Its addresses and numbers are
`candidate`, with source `import`: a spreadsheet is not a technical validation, and
eligibility is the policy's decision (7.4), never a column's. It has no pipeline stage
yet, so the pipeline lists it under **Not in the pipeline yet**.

## Add firm

`POST /crm/firms/add` is the Mac's **Add firm** form (Firms window, any member): a firm
name, its website and time zone, and optionally its first contact's name, title, email and
phone. It is one command and one receipt, and runs the same checks and the same matching
as an import row. A refusal names every field at fault — `{ "reason": "email_invalid",
"issues": [{ "column": "contact_email", "code": "email_invalid" }, …] }` — and a firm that
is already here is `duplicate_in_workspace` with its `firmId`, so the form can offer to
open it. An added firm is assigned to whoever added it, its routes are `candidate` with
source `salesperson`, and the window opens its page.

## The windows

`apps/desktop/src/renderer/firmWorkspace.ts` is a second entry point beside the Today
window, with the same shape: ask the bridge, render what came back, no local model to
go stale. `firmWorkspaceView.ts` holds every decision as a pure function, so 14.2's
"when offline or below the minimum client version, cloud-dependent controls show a
clear non-actionable state" is a unit test rather than a screenshot.

* **Firm page** — identity, routes with eligibility and version, contacts, opportunity
  and stage history, holds and what each blocks. A colleague's page has no sections to
  hide, and the window says why rather than rendering four empty ones.
* **Contacts** — name, title and "make this one the main contact", which is one flag
  the server turns into a demote-and-promote in one transaction. Demoting without
  promoting is not offered: zero primaries is legal, but an unticked box is not a
  decision.
  The bridge sends the edit as the route's `patch`, and an emptied title as an explicit
  `null`, because in a patch an absent field means "unchanged" (lane g88; before it,
  every contact save from the Mac was refused 400).
* **Confirm this number** (lane g88) — a `candidate` phone number on an assigned page
  has the button. `POST /contacts/routes/confirm { routeKind: 'phone', routeId,
  routeVersion }` records the person as the validation: `technical_validation = 'passed'`,
  confidence 1, and `decideRouteEligibility` still decides. The version bumps, and the
  receipt plus the `route.phone.confirmed` audit event record who confirmed it and when.
  A version older than the page is refused `route_version_stale`, a failed number
  `route_invalid`. An email address is not confirmed by hand. Its validation is
  deliverability, which a person cannot supply, and the page says so under an
  unconfirmed address.
* **Sequences** (lane g88) — the enrolments running at this firm, by sequence name and
  version, and a contact and a published version to enrol (`/enrollments/enroll`, with the
  page's firm and open opportunity). A firm with no opportunity is offered **Add to
  pipeline** (`/opportunities/open`, stage New) first; a Won or Lost firm is not
  enrolled from here.
* **Pipeline** — the workspace's configured stages in their order. A retired stage
  with something in it is shown, because "retired stages remain readable"; a retired
  stage is never a destination. A Lost change reveals its reason field and the button
  stays disabled until there is one.
* **Merge resolution** — the conflicts the API refused with, offering only the two
  recorded values, preselecting neither, disabled until every field has been decided.
  A salesperson sees them and cannot commit.
* **Add firm and Import** (lane g84) — two buttons above the pipeline; Import is shown to
  admins only. Add firm comes back after a refusal with what was typed and each field the
  server named marked under it. Import reads a chosen or pasted file on the Mac, previews
  every row with its outcome and issues, and imports nothing until **Import N rows** is
  pressed; the results list each refused row as *Row 3 · Email: Already here.*

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/crm/search.test.ts    # G 8, Appendix F
npm run test --workspace packages/domain -- test/crm/import.test.ts    # G 38
npm run test --workspace packages/domain -- test/crm/capture.test.ts   # one row per contact, Add firm
npm run test --workspace apps/api -- test/capture.test.ts
npm run test --workspace packages/domain -- test/crm/export.test.ts
npm run test --workspace packages/domain -- test/crm/firmPage.test.ts
npm run test --workspace apps/api -- test/crmSurface.test.ts
npm run test --workspace packages/domain -- test/crm/routeConfirm.test.ts   # Confirm this number
npm run test --workspace apps/api -- test/founderGaps.test.ts        # confirm, the title patch, the review read
npm run test:e2e --workspace apps/desktop                              # needs a browser
```

The Playwright specs are deliberately outside `gate:greenfield`: the documented local
install is `npm install --ignore-scripts`, and a gate that needs a browser binary fails
for the wrong reason. See `docs/decisions/g2-desktop-test-layers.md`.
