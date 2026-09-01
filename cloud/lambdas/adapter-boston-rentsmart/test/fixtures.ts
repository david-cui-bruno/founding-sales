/**
 * Real records copied from the live CKAN datastore on 2026-09-01 via:
 *   curl 'https://data.boston.gov/api/3/action/datastore_search?resource_id=dc615ff7-2ff3-416a-922b-f0f334f085d0&limit=3'
 *   curl 'https://data.boston.gov/api/3/action/datastore_search_sql?sql=SELECT * FROM "dc615ff7-..." WHERE "date" > \'2026-08-28\' ...'
 * (Public enforcement records; owner names are public record.)
 */
import type { RentSmartRow } from "../src/rentsmart";

/** Sanitation request (service request, NOT a violation) — identity event. */
export const ROW_SANITATION_REQUEST: RentSmartRow = {
  _id: 1,
  date: "2026-08-29 02:35:00.983+00",
  violation_type: "Sanitation Requests",
  description: "Abandoned Vehicles",
  address: "23 Page St, 02121",
  neighborhood: "Dorchester",
  zip_code: "02121",
  parcel: "1402554000",
  owner: "POWELL UDA M",
  year_built: "1900",
  year_remodeled: "2002",
  property_type: "Residential 2-family",
  latitude: "42.29948000042358",
  longitude: "-71.08320000138492",
};

/** Housing complaint (complaint, NOT a confirmed violation) — identity event. */
export const ROW_HOUSING_COMPLAINT: RentSmartRow = {
  _id: 3,
  date: "2026-08-29 01:33:09.2+00",
  violation_type: "Housing Complaints",
  description: "Unsatisfactory Living Conditions",
  address: "88 Waltham St, 02118",
  neighborhood: "Roxbury",
  zip_code: "02118",
  parcel: "0306885000",
  owner: "EIGHTY 8 WALTHAM STREET CONDOMINIUM ASSN",
  year_built: "1999",
  year_remodeled: null,
  property_type: "Condominium Main*",
  latitude: "42.343300000713135",
  longitude: "-71.07099000094789",
};

/** Enforcement violation (real violation) — trigger violation_opened. */
export const ROW_ENFORCEMENT_VIOLATION: RentSmartRow = {
  _id: 269,
  date: "2026-08-28 00:00:00+00",
  violation_type: "Enforcement Violations",
  description: "Improper storage trash: res",
  address: "34 Robeson St, 02130",
  neighborhood: "Jamaica Plain",
  zip_code: "02130",
  parcel: "1102497000",
  owner: "TRACY PHILIP A JR TS",
  year_built: "1905",
  year_remodeled: null,
  property_type: "Residential 3-family",
  latitude: "42.30984999959373",
  longitude: "-71.10070000064985",
};

/** Enforcement violation with an LLC owner. */
export const ROW_LLC_VIOLATION: RentSmartRow = {
  _id: 76,
  date: "2026-08-28 00:00:00+00",
  violation_type: "Enforcement Violations",
  description: "Improper storage trash: res",
  address: "292 Bennington St 2, 02128",
  neighborhood: "East Boston",
  zip_code: "02128",
  parcel: "0100088000",
  owner: "292 BENNINGTON STREET LLC",
  year_built: "1899",
  year_remodeled: "1990",
  property_type: "Mixed Use (Res. and Comm.)",
  latitude: "42.379049999574185",
  longitude: "-71.02852000152666",
};

/** Synthetic: row with no owner (RentSmart sometimes lacks one). */
export const ROW_NO_OWNER: RentSmartRow = {
  ...ROW_ENFORCEMENT_VIOLATION,
  _id: 9999901,
  owner: null,
};
