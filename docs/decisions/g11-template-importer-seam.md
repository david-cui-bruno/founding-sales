# G11: the template importer is a named seam until migration 0009

Section 2 and section 17 both carry "unapproved template bodies from the old table".
This lane carries three of the four kinds and leaves the fourth deliberately
unfinished.

## Why

`template_versions` does not exist on `main`. It arrives with migration
**0009_mail.sql**, which lane G7-1 is writing in parallel with this one. Two rules in
`docs/greenfield/migrations.md` and `COMMON-G.md` make it impossible for G11 to
supply it:

* migration numbers are assigned by the coordinator and `loadMigrations` refuses a
  gap, so a lane cannot add 0007 for a table another lane is adding at 0009; and
* the brief for this lane says, in as many words, not to add a migration, and to stop
  and report if one seemed unavoidable.

It is avoidable, because the half that needs no table is the larger half.

## What is finished

`apps/worker/tools/carry/templates.ts` reads every `TEMPLATE#` record, counts it in
the manifest, hashes it into the parity check, and turns it into a
`TemplateVersionDraft` — the exact row the writer will insert, against the shape the
coordinator confirmed 0009 lands:

```
(workspace_id, id) composite key
template_id, version, subject, body, content_hash,
footer_postal_address, approved_at, approved_by_user_id, retired_at
UNIQUE (workspace_id, template_id, version)
approved rows immutable by trigger
```

Three things about the drafts are decisions rather than transcription.

**Every carried row is unapproved.** `approved_at` and `approved_by_user_id` are
null. That is section 2's word "unapproved", and it also keeps the immutability
trigger out of the carry's way entirely: an unapproved row may still be edited and an
approved one may not, and a carry has no authority to approve anything. The old
table's `approval.state = 'approved'` is read and discarded — an approval recorded
against the old footer rule is not an approval the greenfield send fence would accept.

**`footer_postal_address` is null.** The old approval bound itself to a postal
address from `SETTINGS#sending`. In the greenfield the footer is workspace
configuration, not template text; carrying the old address would look like an
approval that had been checked against something.

**The old `revision` becomes the `version`.** It is the number the old core bumped on
every edit, so a workspace that edited T1 twice carries version 3 and
`UNIQUE (workspace_id, template_id, version)` holds without the carry inventing a
numbering of its own. `content_hash` is `templateContentHash` from `@fss/domain` —
the same function the send fence uses — so a carried row is comparable with one
written by an ordinary approval.

## What is not finished

One function. `importTemplateVersions` throws `CarryTemplateSeamError` and the import
reports its templates as `deferred: n` rather than counting them as carried. The
acceptance it owes is written and skipped:

```
apps/worker/test/carry/templateSeam.test.ts
  describe('the template importer, once template_versions exists')
    it.skip('writes one unapproved version per old template and is idempotent')
```

## Turning it on

1. Migration 0009 is on `main` with `template_versions` as above.
2. Replace the throw in `importTemplateVersions` with the scoped insert quoted in
   its own doc comment — `ON CONFLICT ... DO NOTHING`, which is what makes the second
   run report `reused` exactly as `recordEvidence` does.
3. Turn `it.skip` into `it`.
4. Pass `templateImporter: importTemplateVersions` from `runCarryImport`'s caller in
   `cli.ts`; `CarryImportInput` already takes it.
5. Delete step 9's caveat in `docs/greenfield/carry-runbook.md`.

Until then the runbook says plainly that the template bodies are read and counted but
not written, and that David re-enters or re-approves the five templates by hand. That
is a smaller loss than it sounds: the bodies are five short texts, the old approvals
were void under the new footer rule anyway, and every one of them would have had to
be re-approved.
