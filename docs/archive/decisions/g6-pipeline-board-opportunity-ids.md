# G6: the pipeline board can only offer a stage change for a firm it has opened

**Date:** 20 September 2026 · **Lane:** G6 Today list (CRM wiring) · **Spec:** 8.1, Appendix F

## What was found while wiring G3b's windows

`PipelineView` in `apps/desktop/src/renderer/firmWorkspaceContract.ts` carries
`opportunityIdByFirmId`, and `pipelineBoard.ts` renders a stage control for a firm that
is in it and G3b's `stage-change-unavailable` for a firm that is not. The bridge has to
fill that map.

There is nothing to fill it from. The board's firms come from `GET /firms`, which
returns `FirmIdentityDto` — Appendix F's first row, "firm identity, pipeline
stage/dates, sequence status, call outcomes without notes". It carries `stageKey`,
`opportunityStatus`, `controlMode` and `openedAt`, and it does not carry the
opportunity's id. `firmIdentityDtoSchema` is a `strictObject`, so there is nowhere to
put one either.

## What was done

`createCrmBridge` remembers every opportunity id a Firm page has told it about, and
passes that map to `pipelineViewOf`. A column whose firm has been opened offers a stage
change; every other column renders `stage-change-unavailable`, which is a state G3b's
renderer already draws and a person can already act on by opening the firm.

Nothing was invented. The bridge does not guess an id, does not read a firm the API did
not return, and does not call `/crm/firm-page` once per column to fill the map — which
would be a read per firm on every board load, and an access audit event per firm for an
admin (5.2).

## Why not just add the id to the DTO

Because the DTO is not this lane's, and because whether it belongs there is a real
question rather than an oversight. Appendix F's first row is what *any active member*
may see about *any* firm, including a colleague's. An opportunity id is a handle to a
mutation: `POST /opportunities/stage` takes one, and the refusal for a firm that is not
yours happens under the firm's row lock in the domain. Putting the handle in the
colleague-visible read is not a leak — the mutation is still refused — but it is a
widening of that row, and the lane that owns Appendix F should make it.

## What the owning lane should decide

One of:

1. add `opportunityId` to `FirmIdentityDto`, on the grounds that a handle whose every
   use is authorized elsewhere is not sensitive; or
2. add a `GET /pipeline/board` that returns the columns with their ids, scoped and
   audited as one read rather than as N; or
3. leave it, and let the board be a read-only overview from which a person opens a firm.

This lane has no preference it can justify from the specification. Until then the
behaviour above is the conservative one: fewer controls, none of them broken.
