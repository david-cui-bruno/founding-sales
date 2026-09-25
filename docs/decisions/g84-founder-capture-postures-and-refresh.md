# g84: a founder adds and imports firms, records postures, and Today keeps itself current

**Date:** 25 September 2026 · **Lane:** g84 founder product gaps · **Spec:** 7.2, 7.4, 8.2,
9.2, 10.1, 14.2 · **Audit:** `GPT6-ASTRA-EXHAUSTIVE-20260925.md` G02, G04, G05

## What was wrong

* **G02.** An empty workspace could not be filled from the Mac. The CRM window opened and
  edited firms that already existed; nothing created one, added a contact or added a
  route. `POST /import/*` existed with no screen, and it treated the second line of a
  firm — the next person there — as a duplicate of the first.
* **G04.** 9.2 step 6 refuses a call to a firm whose state has no posture in force, and
  Settings answered that with the text `/postures — G4 policy`. Nothing on the Mac could
  record one.
* **G05.** Home read Today's list at sign-in and on Refresh and nowhere else. A window
  left open overnight showed yesterday's list the next morning, and nothing said how old
  it was.

## Decisions

### 1. One row is one contact, matched to its firm

A prospect list has a line per person with the firm's columns repeated, so that is the
format. A row's firm is the workspace's firm with the same external id, else website
domain, else name (a name match is not taken when both sides have websites that
disagree); failing that, a firm an earlier row creates. A row that adds a new person to a
matched firm is `attach`. A row is `duplicate` only when it adds nothing: its contact is
already at the firm (by email, or by name without one), or it names only the firm. Two
workspace firms matching one row is `firm_ambiguous` rather than a guess.

*Rejected:* one row per firm with numbered contact columns (nobody exports that shape);
keeping "a repeated firm is a duplicate" (it made every multi-person firm a refusal).

### 2. The commit decides again, row by row, and a row is all or nothing

`POST /import/commit` still takes the file, not the preview, and re-previews it. Rows run
in the file's order, whatever order they were asked in, so an `attach` row finds the firm
its creating row just made; if that row was not committed, the attach row creates the
firm from its own columns. Each row is one `runCommand` (`crm.import_row`), whose payload
is the row's parsed fields and never its classification, so a replay after the firm
landed still matches its receipt. Inside the command the row runs in a savepoint: a row
refused at its contact takes its firm back with it. A refusal stores `{ column }` on the
receipt, so the replay names the same field.

### 3. Add firm is an import row typed by hand

`POST /crm/firms/add` (`crm.add_firm`, any active member) builds the same draft, runs the
same checks and the same matching, and returns every issue at once with the column each
names. A matched firm is `duplicate_in_workspace` with its `firmId`.

### 4. What a captured firm is

* **Assigned to whoever captured it** (or the import row's `owner_user_id`). Dialing
  requires the firm to be assigned to the caller, even for an admin (`dial/authorize.ts`
  step 4), so an unassigned firm could be called by nobody.
* **Routes start where the policy starts them.** `addEmailRoute` and `addPhoneRoute` run
  `decideRouteEligibility`, which gives `candidate` without a passed technical
  validation. Nothing here chooses a state. The source is `import` or `salesperson`.
* **The zone is resolved at once** from the typed time zone, else the postal code or
  state; an unresolved zone is not a refusal (calls wait for it, as they always have).

*Dropped from the brief's form:* the "posture/notes" field. Firms have no notes column,
and adding one is migration 0018 plus a new field on the firm page read (a strict object
in the contract) for a note nothing else reads yet. The lane was asked to avoid a
migration.

*Not built:* a way to verify a candidate route from the Mac. A captured number is on the
firm page but not dialable until something validates it; that is the route policy's
lane.

### 5. The postures form records; it does not decide

The Settings section **Calling postures** lists every posture (state, revision, dates,
status, Revoke) and a form: a state (states with a rule quoted in `statePosture.ts`
first), the day it takes effect, a review date (empty means a year on), one box per
statement, and a note. The statements, the federal citations and each state's quoted
rule come from `GET /postures/reference`, verbatim, rather than a copy on the Mac —
invariant 7, "Software records and enforces legal posture; it does not invent it". Dates
are days in the business zone, sent as that day's midnight through the domain's own clock.
The form says before sending what the server would refuse (no state, a bad date, an
unticked statement, an overlap with a posture in force); the server still decides. The
records are also shown as JSON behind **Show as JSON**.

The API's record route now runs the command in a savepoint. The exclusion constraint
refuses an overlapping posture inside the command's transaction; without the savepoint
the receipt insert failed and the route answered 500 where the domain meant
`posture_overlapping`. The policy domain is untouched.

### 6. Today reads itself again, quietly, and never over typing

* **On focus**, when the last read is at least a minute old.
* **At the rollover**: 05:00 in the business zone, when 8.2 builds the day's list, and
  05:10 again for a slow build. The question asked every 30 seconds is "has a rollover
  passed since the last read", so a Mac that slept through 05:00 reads on waking.
* **Quietly**: `refresh({ quiet: true })` keeps the notice on screen, as the re-read after
  a mutation does; a pressed Refresh still clears it.
* **Never over typing**: while a field in the lanes has focus, or anything was typed or
  chosen there since the lanes were drawn, the read waits for a later tick.
* **No flicker**: the list on screen stays while a read is in flight. The lanes are
  redrawn only when what they draw changed; `asOf` is left out of that comparison,
  because every read changes it and the lanes never show it.
* **The age is said**: "Updated just now", "Updated 4 min ago", written in place every
  30 seconds. A failed read adds "Could not refresh." and **Retry** beside it, under the
  offline or stale line Home already shows.

A failed read falls back to the encrypted cache, which re-checks its 24-hour expiry, so an
offline Mac left open past a day drops the list at the next focus or rollover rather than
showing it.

## Compatibility

No migration; the schema stays where main has it. Nothing the installed 1.0.4 parses has
changed: 1.0.4 never calls `/import/*` or `/postures*`, the two new endpoints are new, and
every other answer is untouched. The new desktop needs the new API (`/crm/firms/add`, `/postures/reference`, and
the preview's `attach` and `match`), so the API is deployed first.
