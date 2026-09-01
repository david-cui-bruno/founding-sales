/**
 * Real rows copied from the live endpoint on 2026-09-01 via:
 *   curl "https://data.providenceri.gov/resource/6ub4-iebe.json?\$where=class='2'&\$order=p_id&\$limit=3"
 *   curl "https://data.providenceri.gov/resource/6ub4-iebe.json?\$where=class='1'&\$order=p_id&\$limit=2"
 *   curl "https://data.providenceri.gov/resource/6ub4-iebe.json?\$where=class='6'&\$order=p_id&\$limit=1"
 * (Public tax-roll records; owner names are public record.)
 */
import type { TaxRollRow } from "../src/taxroll";

/** class 2 (2-5 Family), individual owner, owner-occupied (mailing == situs street, differing zip). */
export const ROW_TWO_FAMILY_OWNER_OCC: TaxRollRow = {
  p_id: "30",
  tax_map: "001-0032-0000",
  plat: "1",
  lot: "32",
  unit: "0000",
  class: "2",
  short_desc: "2 -5 Family",
  levy_code_1: "OO2-5",
  short_desc_1: "OO 2-5",
  civic: "13",
  street: "Nashua",
  suffix: "St",
  formated_address: "13 Nashua St",
  city: "Providence",
  zip_postal: "02906",
  first_name: "Ricardo",
  last_name: "Baez",
  civic_1: "13",
  street_1: "Nashua",
  s_suffix: "St",
  city_1: "Providence",
  state: "RI",
  zip_postal_1: "02904",
  total_assmt: "409100",
  total_exempt: "0",
  total_taxes: "3088.72",
  property_location: { type: "Point", coordinates: [-71.40391, 41.85055] },
};

/** class 2 (2-5 Family), LLP org owner, absentee (PO Box mailing). */
export const ROW_TWO_FAMILY_LLP_ABSENTEE: TaxRollRow = {
  p_id: "34",
  tax_map: "001-0040-0000",
  plat: "1",
  lot: "40",
  unit: "0000",
  class: "2",
  short_desc: "2 -5 Family",
  levy_code_1: "NOO2-5",
  short_desc_1: "NOO 2-5",
  civic: "24",
  street: "Nashua",
  suffix: "St",
  formated_address: "24 Nashua St",
  city: "Providence",
  zip_postal: "02906",
  company: "Natale Family LLP",
  street_1: "PO Box 6547",
  city_1: "Providence",
  state: "RI",
  zip_postal_1: "02940",
  total_assmt: "373200",
  total_exempt: "0",
  total_taxes: "5224.80",
  property_location: { type: "Point", coordinates: [-71.40377, 41.8508] },
};

/** class 1 (Single Family), individual owner, owner-occupied. */
export const ROW_SINGLE_FAMILY_OWNER_OCC: TaxRollRow = {
  p_id: "28",
  tax_map: "001-0030-0000",
  plat: "1",
  lot: "30",
  unit: "0000",
  class: "1",
  short_desc: "Single Family",
  levy_code_1: "OO01",
  short_desc_1: "OO01",
  civic: "21",
  street: "Nashua",
  suffix: "St",
  formated_address: "21 Nashua St",
  city: "Providence",
  zip_postal: "02906",
  first_name: "Joseph",
  last_name: "McCloskey",
  civic_1: "21",
  street_1: "Nashua",
  s_suffix: "St",
  city_1: "Providence",
  state: "RI",
  zip_postal_1: "02904",
  total_assmt: "312700",
  total_exempt: "0",
  total_taxes: "2626.68",
  property_location: { type: "Point", coordinates: [-71.40378, 41.85079] },
};

/** class 6 (Commercial II), LLC owner — must be filtered out regardless. */
export const ROW_COMMERCIAL: TaxRollRow = {
  p_id: "19",
  tax_map: "001-0007-0000",
  plat: "1",
  lot: "7",
  unit: "0000",
  class: "6",
  short_desc: "Commercial II",
  levy_code_1: "C01",
  short_desc_1: "C01",
  civic: "1052",
  street: "North Main",
  formated_address: "1052 North Main",
  city: "Providence",
  zip_postal: "02906",
  company: "RAB Properties LLC",
  city_1: "Providence",
  state: "RI",
  zip_postal_1: "02940",
  total_assmt: "507400",
  total_exempt: "0",
  total_taxes: "14816.08",
  property_location: { type: "Point", coordinates: [-71.40342, 41.84963] },
};

/** Synthetic: absentee single-family (rental SFH) built from ROW_SINGLE_FAMILY_OWNER_OCC. */
export const ROW_SINGLE_FAMILY_ABSENTEE: TaxRollRow = {
  ...ROW_SINGLE_FAMILY_OWNER_OCC,
  p_id: "9999901",
  levy_code_1: "NOO01",
  civic_1: "500",
  street_1: "Angell",
  s_suffix: "St",
  city_1: "Cranston",
  zip_postal_1: "02910",
};
