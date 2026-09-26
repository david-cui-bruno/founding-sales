# G11: the old record's time zone is not carried as a recorded zone

Every `FIRM#` record in the old table carries a `timeZone`, derived by the old core
from a **state-wide map** (`TERRITORY_STATE_TIME_ZONES`, `TERRITORY_ADDABLE_STATE_TIME_ZONES`
in `firmsWrite.ts`). The carry does not use it.

`resolveFirmZone` in `@fss/domain` treats a `recordedZone` as source `recorded` at
**high** confidence, which is right for a zone somebody established deliberately and
wrong for this one. Section 9.2 of revision 3 says, in as many words: "Multi-zone
states do not use a state-wide time-zone shortcut." Passing the old value in would
launder exactly the shortcut the specification forbids into the highest confidence
the column has, and `authorizeDial` would then allow a call at 07:00 local for a
Texas firm the old map had put in Central.

So the carry passes the old `state` as `region_code` and the old `city` as
`locality`, and calls `resolveZoneForFirm`, which runs the versioned rule:

| Old state | What the carry produces | Effect |
|---|---|---|
| A single-zone state (RI, MA, …) | the state default, `medium` confidence | callable |
| A multi-zone state (TX, FL, MI, …) with no postal code | no zone, `state_spans_zones` | **not callable** |
| No state at all — every `ACCOUNT#` firm | no zone, `no_location` | **not callable** |

That is a deliberate loss of reach in exchange for invariant 2. "Inability to
establish it blocks calling" is the specification's own sentence, and a firm that
arrives uncallable is a firm David fixes by recording its address — one command, with
a record of who decided — rather than one FSS dials at an hour nobody chose.

`apps/worker/test/carry/roundTrip.test.ts` asserts both halves of the table above on
a Rhode Island firm and a Texas firm.

## The `ACCOUNT#` row of that table

The old core derived an `ACCOUNT#` firm's state from the Places listing's
`formattedAddress`, inside the record's own excerpts. Reimplementing that parser here
would be a guess at a firm's location made by a tool that runs once and is then
deleted, and a wrong guess is a call in the wrong state. The excerpts travel in the
evidence, so the address is still readable; it is simply not a canonical field the
carry filled in.

## What David has to do about it

Step 8 of `docs/greenfield/carry-runbook.md`: after the import, list the firms with
no zone and record the address for the ones he intends to call. Nothing else is
blocked — email windows, research and the Today list all work without it; only
dialing is held.
