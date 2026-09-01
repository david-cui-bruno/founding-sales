# Verified Data Endpoints (live-probed 2026-09-01)

Every endpoint below returned real data during probing. Adapters should cite this doc.
Re-verify before building; portals move.

## Providence

### Tax roll (owner + parcel identity) — PRIMARY cold source for PVD
- Socrata: `https://data.providenceri.gov/resource/6ub4-iebe.json` (2025 Property Tax Roll)
- SoQL supported (`$limit`, `$where`, `$offset`). No app token needed at low rates
  (throttled without one; register an app token if we see 429s).
- Fields (verified): `p_id`, `tax_map`, `plat`, `lot`, `unit`, `class` + `short_desc`
  (use codes, e.g. "CI Vacant Land"), situs: `civic`,`street`,`suffix`,`formated_address`,
  `city`,`zip_postal`; owner: `company` (name, incl. LLCs), mailing: `civic_1`,`street_1`,
  `s_suffix`,`city_1`,`state`,`zip_postal_1`; `total_assmt`, `total_taxes`,
  `property_location` (GeoJSON point).
- Absentee = mailing address ≠ situs address. Portfolio = group by normalized `company`
  + mailing address.
- Historical rolls back to 2002 exist (year-over-year owner diffs = deed-transfer proxy
  for Providence, in addition to the deeds pass).
- Also on the portal: `ufmm-rbej` Department of Inspections and Standards Permits
  2009-2018 (stale; NOT a live permit source).

### Permits (live) — ViewPoint/OpenGov
- `https://providenceri.viewpointcloud.com/api/v2/public/records?limit=N` returns 200
  anonymously (the `workflow.opengov.com` variant 403s).
- Response shape needs mapping work (OpenGov record objects). Adapter must page and
  filter by record type. Rate-limit conservatively; this is a public but undocumented API.

## Boston (CKAN, open license, documented)

- Package search: `https://data.boston.gov/api/3/action/package_search`
- **Approved building permits**: package `approved-building-permits`, CSV resource
  `6ddcd912-32a0-43df-9908-63574f8c7e77`. Datastore API:
  `https://data.boston.gov/api/3/action/datastore_search?resource_id=<id>&limit=N`
- **Building and property violations**: package `building-and-property-violations1`,
  CSV resource `800a2663-1d6a-46e7-9356-bedb70f5332c`.
- **RentSmart** (package `rentsmart`): pre-joined violations/permits/complaints per
  rental address — possibly the highest-value single Boston dataset, check first.
- **Short-term rental eligibility** (package `short-term-rental-eligibility`): flags
  owner-occupancy status per address.

## Rhode Island statewide

- RIGIS ArcGIS org (`services2.arcgis.com/S8zZg9pg23JUEexQ`) has **no statewide parcel
  FeatureServer** — only coastal SLAMM subsets. Statewide parcels are distributed as
  per-municipality annual downloads via rigis.org (E911 address points ARE available:
  `FACILITY_E911_AddressPoints`).
- Providence tax roll (above) covers the launch market without RIGIS.
- RI Rental Registry: no API; APRA bulk request drafted in
  `docs/sourcing/founder-actions/apra-request.md`; targeted portal lookups for v0.

## Massachusetts

- MassGIS statewide parcels (L3): bulk download, semiannual refresh — adapter reads the
  published GDB/shape exports. (Not yet probed; verify at build time.)
- masslandrecords.com: no API, weekly low-rate name/date search pass (build last).

## Cadence recommendations (from observed update stamps)

| Source | Observed freshness | Adapter cadence |
|---|---|---|
| PVD tax roll | annual roll, updated in-year | weekly diff |
| PVD ViewPoint permits | live | daily |
| Boston permits/violations/RentSmart | daily-ish | daily |
| RIGIS E911 addresses | yearly | on demand |
