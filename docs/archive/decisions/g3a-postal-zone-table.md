# G3a: the postal time-zone table covers two states, on purpose

**Date:** 20 September 2026 · **Lane:** G3a CRM core · **Spec:** 9.2, Appendix D

## Spec silence

Section 9.2 says the firm's zone "is resolved from location or postal data under a
versioned source rule" and that "multi-zone states do not use a state-wide time-zone
shortcut". `resolveFirmZone` in `@fss/domain` is the seam G0 left; the brief asks this
lane to fill it in. The specification does not say what the source rule contains, and
it does not say what to do where the rule cannot decide.

Where the spec is silent, the common rule says take the conservative option. It also
says, in the same section, what the conservative option is here: "inability to
establish it blocks calling".

## Decision

`packages/domain/crm/zone.ts`, rule version `postal-zone.1`, answers for two states
and `null` for everything else.

| State | Rule |
|---|---|
| Texas | `America/Chicago`, except ZIP prefixes `798`, `799` and `885` (El Paso and Hudspeth counties), which are `America/Denver` |
| Florida | `America/New_York`, except prefixes `324` and `325` (the western panhandle), which are `America/Chicago` |

Every other state — including the other thirteen in `MULTI_ZONE_STATES` — gets `null`,
which leaves `resolveFirmZone` to fall through to the single-zone state default or to
`state_spans_zones`. A firm in one of those states with no recorded zone stays
unresolved, the firm row records `time_zone_unresolved_reason`, and `authorizeDial`
(G4) refuses it.

## Why the table is this small

Of the fifteen multi-zone states, only these two have a boundary that follows whole
three-digit ZIP prefixes cleanly enough to write down and defend.

The other thirteen have boundaries that cut *through* prefixes: Michigan's Upper
Peninsula (four Central counties inside the `498`/`499` prefixes that otherwise run on
Eastern), Indiana's county-by-county line, the Navajo Nation inside Arizona, and the
Nebraska, Dakota and Kansas panhandles where a single prefix spans the boundary. A
three-digit guess in any of those would be wrong for real firms.

The cost of being wrong is not symmetric. A missing zone is a hold: the salesperson
sees the firm and cannot dial it until someone records the zone. A *wrong* zone is a
call placed outside the recipient's local window, which is the thing invariant 2 exists
to prevent and which the software cannot detect afterwards. So the table answers only
where it is sure.

## Extending it

Adding a state is a versioned change: the new entry goes in, `POSTAL_ZONE_RULE_VERSION`
becomes `postal-zone.2`, and the firms resolved under `postal-zone.1` are findable by
`firms.time_zone_rule_version` so they can be re-decided. That column exists for this.

A better source — a real ZIP-to-zone dataset, or coordinates — plugs in as another
`FirmZoneSource` beside this one, ahead of it in `FIRM_ZONE_SOURCES`. The seam takes a
list in order precisely so a better source can be added without removing this one.

## A question for the coordinator

Lane G10 (research) will have coordinates from the Places provider for most discovered
firms, and a coordinate lookup is strictly better than a postal prefix. If G10 is
going to carry a coordinate-to-zone source anyway, this table should probably stay at
two states permanently and be superseded rather than grown.
