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
packages/domain/crm/import.ts                  the CSV parser, the preview, the commit
packages/domain/crm/exports.ts                 the rows and the audit event
packages/domain/crm/firmPage.ts                opportunity, stage history, holds
packages/contracts/src/crmSurface.ts           the wire contract
apps/api/src/routes/{search,import,export,firmPage}.ts
apps/api/src/routes/modules.ts                 which router owns which paths
apps/desktop/src/renderer/firmWorkspace.ts     the CRM window's entry point
apps/desktop/src/renderer/firmWorkspaceView.ts what it shows, as a pure function
apps/desktop/src/renderer/{firmPage,contactsEditor,pipelineBoard,firmMerge}.ts
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

One header row, these columns in any order, all of them optional except `firm_name`:

```
firm_name, website, address_line, locality, region_code, postal_code,
external_id, owner_user_id, contact_name, contact_title, contact_email, contact_phone
```

An unknown column, a row of the wrong width or an empty file is refused whole: a file
that half-parses is a file somebody exported from the wrong system.

A row is `create`, `duplicate` or `invalid`, and carries the issues that made it so.
Invalid beats duplicate, because a row that is both should be shown the fault it can
fix. A bad email address or an unparseable number makes the whole row invalid rather
than importing the firm and dropping the route: a route silently missing is a firm
nobody can contact and nobody knows why.

A ten-digit number is taken as North American and eleven digits starting with 1 as the
same; anything else needs its `+`. A guess would be dialed at a stranger.

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
* **Pipeline** — the workspace's configured stages in their order. A retired stage
  with something in it is shown, because "retired stages remain readable"; a retired
  stage is never a destination. A Lost change reveals its reason field and the button
  stays disabled until there is one.
* **Merge resolution** — the conflicts the API refused with, offering only the two
  recorded values, preselecting neither, disabled until every field has been decided.
  A salesperson sees them and cannot commit.

## Running the tests

```
npm run gate:greenfield
npm run test --workspace packages/domain -- test/crm/search.test.ts    # G 8, Appendix F
npm run test --workspace packages/domain -- test/crm/import.test.ts    # G 38
npm run test --workspace packages/domain -- test/crm/export.test.ts
npm run test --workspace packages/domain -- test/crm/firmPage.test.ts
npm run test --workspace apps/api -- test/crmSurface.test.ts
npm run test:e2e --workspace apps/desktop                              # needs a browser
```

The Playwright specs are deliberately outside `gate:greenfield`: the documented local
install is `npm install --ignore-scripts`, and a gate that needs a browser binary fails
for the wrong reason. See `docs/decisions/g2-desktop-test-layers.md`.
