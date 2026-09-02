/**
 * Test fixtures: enrichment requests and deterministic Tracerfy responses
 * shaped exactly like the sandbox (mock.tracerfy.com) output.
 */
import type { EnrichmentRequest } from "@callie-sourcing/shared";
import type { TracerfyLookupResponse, TracerfyPerson } from "../src/tracerfy";

export const CE_ID = "ce_01JC0000000000000000000000";
export const CE_ID_2 = "ce_01JC0000000000000000000001";

export function request(overrides: Partial<EnrichmentRequest> = {}): EnrichmentRequest {
  return {
    cloud_entity_id: CE_ID,
    requested_at: "2026-09-01T15:00:00.000Z",
    situs_address: {
      line1: "123 Hope St",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
    },
    owner_full_name: "JANE ROE",
    ...overrides,
  };
}

export function person(overrides: Partial<TracerfyPerson> = {}): TracerfyPerson {
  return {
    first_name: "Jane",
    last_name: "Roe",
    full_name: "Jane Roe",
    deceased: false,
    property_owner: true,
    litigator: false,
    mailing_address: {
      street: "PO Box 111",
      city: "Providence",
      state: "RI",
      zip: "02906",
    },
    phones: [
      {
        number: "4015550100",
        type: "Mobile",
        dnc: false,
        tcpa: false,
        carrier: "T-MOBILE USA INC.",
        rank: 1,
      },
      {
        number: "4015550200",
        type: "Landline",
        dnc: true,
        tcpa: false,
        carrier: "VERIZON",
        rank: 2,
      },
    ],
    emails: [{ email: "Jane.Roe@Example.com", rank: 1 }],
    ...overrides,
  };
}

export function hitResponse(
  persons: TracerfyPerson[] = [person()],
): TracerfyLookupResponse {
  return {
    hit: persons.length > 0,
    persons_count: persons.length,
    credits_deducted: persons.length > 0 ? 5 : 0,
    persons,
  };
}

export function missResponse(): TracerfyLookupResponse {
  return { hit: false, persons_count: 0, credits_deducted: 0, persons: [] };
}
