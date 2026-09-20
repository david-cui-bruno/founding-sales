# G10: the coordinate table supersedes the postal table, and refuses every seam

**Date:** 20 September 2026 · **Lane:** G10 research · **Spec:** 9.2, Appendix D

## The question this answers

`docs/decisions/g3a-postal-zone-table.md` ends with one:

> Lane G10 (research) will have coordinates from the Places provider for most
> discovered firms, and a coordinate lookup is strictly better than a postal prefix. If
> G10 is going to carry a coordinate-to-zone source anyway, this table should probably
> stay at two states permanently and be superseded rather than grown.

The coordinator's note of 20 September answers it: make coordinate-based resolution the
primary rule, keep the postal table as the fallback for hand-entered firms, and do not
grow it. This records how the coordinate rule is built, because section 9.2 says only
that the rule is versioned and that failing to establish a zone blocks calling.

## Decision

`packages/domain/research/zone.ts`, rule version `coordinate-zone.1`, is a **per-state
boundary table** with an explicit margin. `RESEARCH_FIRM_ZONE_SOURCES` is
`[coordinateZoneSource, postalZoneSource]`; `FIRM_ZONE_SOURCES` in `@fss/domain/crm` is
unchanged.

It is not a reverse geocoder and not a time-zone shapefile. A real boundary dataset is
a dependency, a licence and a periodic update, and version one does not need any of
that to be correct — it needs to be correct or silent.

Within one state a United States time-zone boundary is close enough to a single
meridian, or in Idaho's case a single parallel, to write down. Across states it is not,
which is why the table is keyed by state and why a coordinate with no state gets
nothing from it.

| State | Axis | Boundary | Margin | Lower | Upper |
|---|---|---|---|---|---|
| AK | longitude | −169.5 | 0.5 | `America/Adak` | `America/Anchorage` |
| FL | longitude | −85.0 | 0.25 | `America/Chicago` | `America/New_York` |
| ID | **latitude** | 45.5 | 0.3 | `America/Boise` | `America/Los_Angeles` |
| IN | longitude | −87.3 | 1.0 | *(refuses)* | `America/Indiana/Indianapolis` |
| KS | longitude | −101.5 | 0.3 | `America/Denver` | `America/Chicago` |
| KY | longitude | −86.0 | 0.2 | `America/Chicago` | `America/Kentucky/Louisville` |
| MI | longitude | −87.6 | 0.3 | `America/Menominee` | `America/Detroit` |
| NE | longitude | −101.2 | 0.3 | `America/Denver` | `America/Chicago` |
| NV | longitude | −114.1 | 0.4 | `America/Los_Angeles` | *(refuses)* |
| ND | longitude | −101.0 | 0.4 | `America/Denver` | `America/Chicago` |
| OR | longitude | −118.5 | 0.3 | `America/Los_Angeles` | *(refuses)* |
| SD | longitude | −100.5 | 0.4 | `America/Denver` | `America/Chicago` |
| TN | longitude | −85.5 | 0.3 | `America/Chicago` | `America/New_York` |
| TX | longitude | −105.0 | 0.5 | `America/Denver` | `America/Chicago` |

Arizona is absent. The part of it that observes daylight saving is the Navajo Nation,
and no meridian or parallel separates it from the rest.

## The margin is the design

A coordinate inside the margin resolves to **nothing**. G3a's asymmetry argument applies
unchanged and is worth restating: a missing zone is a hold, which a person clears by
recording the zone; a *wrong* zone is a call placed outside the recipient's local
business window, which invariant 2 exists to prevent and which the software can never
detect afterwards.

So each rule answers the interior of each side and refuses the seam. Chattanooga, at
−85.31, is inside Tennessee's 0.3° margin and resolves nothing. Hudspeth County, Texas,
reaches east of the 105th meridian, which is why Texas's margin is the widest at 0.5°.
Louisville sits close to Kentucky's line and is Eastern, which is why Kentucky's is the
narrowest at 0.2°.

## A `null` side is an enclave, said out loud

Three states have a minority zone that is not a half-plane at all:

* **Indiana** — twelve Central counties in two clusters, bounded by county lines;
* **Nevada** — one town on the Utah border;
* **Oregon** — most of Malheur County, bounded by latitude as well as longitude.

For these the table resolves the large side and returns `null` for the small one. A
half-plane that claimed the enclave would be wrong for every firm in the counties
beside it, and the honest encoding is to say nothing.

## Two guards against a typo in the table

1. `zoneForCoordinate` returns `null` unless the answer is one of the two zones
   `MULTI_ZONE_STATES` says the state observes. A table edit that produced a third
   would be a typo, and a typo here is a wrong call hour.
2. It returns `null` for every single-zone state, so the state rule's certainty is
   never relabelled as a coordinate's. `resolveFirmZone` falls through to
   `state_default` there, with `medium` confidence, exactly as before.

A coordinate of `0, 0` is refused as unusable: it is what a provider returns when it has
no coordinate, and it is in the Gulf of Guinea.

## Why `FIRM_ZONE_SOURCES` is not changed

G3a's CRM command `resolveZoneForFirm` still resolves from the postal table alone, and
this lane adds `resolveResearchFirmZone` beside it. Two reasons:

* a firm typed in by hand has an address and no coordinate, so a coordinate source
  there would only ever return `null`;
* `packages/domain/crm` importing `packages/domain/research` would be a cycle — research
  imports the CRM's firm loader, its authorization and its postal source.

The seam takes a list in order precisely so a better source can be added without
removing the old one, and that is what happened: research passes `[coordinates,
postal]`, hand entry passes `[postal]`, and a firm with both a coordinate and a postal
code that disagree resolves from the coordinate.

## Extending it

Adding a state, moving a boundary or narrowing a margin is a versioned change: the
entry goes in and `COORDINATE_ZONE_RULE_VERSION` becomes `coordinate-zone.2`. The firms
resolved under the old one are findable by `firms.time_zone_rule_version`, which is what
that column is for.

The postal table stays at two states, permanently, and is superseded rather than grown.
