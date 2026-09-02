import type { CloudSourceEvent } from '../../src/shared/contracts/cloudSourceEventContract';

const IDEMPOTENCY_KEY = 'a'.repeat(64);

export function validFrboEvent(): CloudSourceEvent {
  return {
    contract_version: 1,
    id: 'se_01JC0000000000000000000000',
    idempotency_key: IDEMPOTENCY_KEY,
    channel: 'frbo',
    source_uri: 'ses:zillow-alert:abc123',
    fetched_at: '2026-09-01T03:00:00.000Z',
    observed_at: '2026-09-01T02:59:00.000Z',
    entity: {
      cloud_entity_id: 'ce_01JC0000000000000000000000',
      person: null,
      property: {
        situs_address: {
          line1: '123 Hope St',
          locality: 'Providence',
          region: 'RI',
          postal_code: '02906',
          country_code: 'US',
        },
        parcel_id: null,
        unit_count: null,
        year_built: null,
        use_code: null,
      },
      known_person: false,
    },
    payload: {
      listing_url: 'https://www.zillow.com/homedetails/123',
      rent_usd: 2200,
      beds: 3,
      baths: 1.5,
      property_kind: 'multi_family',
      listed_at: null,
    },
    signal_flags: {
      self_managed: true,
      vacancy: null,
      pain_mentions: [],
      urgency: 1,
      portfolio_hint: null,
    },
    trigger: {
      type: 'frbo_listing',
      weight: 1.0,
      half_life_days: 3,
      window: null,
    },
    scores: null,
    provenance: {
      adapter: 'mail-parse',
      adapter_version: '1.0.0',
      confidence: 0.9,
    },
  };
}

export function validParcelEvent(): CloudSourceEvent {
  return {
    contract_version: 1,
    id: 'se_01JC0000000000000000000001',
    idempotency_key: 'b'.repeat(64),
    channel: 'parcel',
    source_uri: 'rigis:parcels:PROV-123-456',
    fetched_at: '2026-09-01T03:00:00.000Z',
    observed_at: '2026-08-30T00:00:00.000Z',
    entity: {
      cloud_entity_id: 'ce_01JC0000000000000000000001',
      person: {
        full_name: 'JANE ROE',
        mailing_address: {
          line1: '77 Benefit St',
          locality: 'Providence',
          region: 'RI',
          postal_code: '02906',
          country_code: 'US',
        },
        phones: ['+14015551234'],
        emails: ['jane@example.com'],
        org_names: ['ROE PROPERTIES LLC'],
      },
      property: {
        situs_address: {
          line1: '9 Doyle Ave',
          locality: 'Providence',
          region: 'RI',
          postal_code: '02906',
          country_code: 'US',
        },
        parcel_id: 'PROV-123-456',
        unit_count: 3,
        year_built: 1918,
        use_code: '3F',
      },
      known_person: false,
    },
    payload: {
      assessor_class: '2',
      assessed_value_usd: 412000,
      tax_usd: 5100,
      absentee: true,
      owner_kind: 'individual',
      tax_year: 2026,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: 2,
    },
    trigger: null,
    scores: null,
    provenance: {
      adapter: 'providence-tax-roll',
      adapter_version: '1.0.0',
      confidence: 0.95,
    },
  };
}

/**
 * A real cloud-shaped enrichment event: channel `parcel`, payload =
 * enrichmentPayloadSchema (Tracerfy skip trace). Phones carry DNC/TCPA
 * flags, emails are lowercase, ranks order the contacts.
 */
export function validEnrichmentEvent(): CloudSourceEvent {
  return {
    contract_version: 1,
    id: 'se_01JC0000000000000000000002',
    idempotency_key: 'c'.repeat(64),
    channel: 'parcel',
    source_uri: 'tracerfy:enrich:ce_01JC0000000000000000000001',
    fetched_at: '2026-09-02T03:00:00.000Z',
    observed_at: '2026-09-02T02:59:00.000Z',
    entity: {
      cloud_entity_id: 'ce_01JC0000000000000000000001',
      person: {
        full_name: 'JANE ROE',
        mailing_address: null,
        phones: [],
        emails: [],
        org_names: [],
      },
      property: null,
      known_person: true,
    },
    payload: {
      vendor: 'tracerfy',
      hit: true,
      phones: [
        {
          e164: '+14015550101',
          kind: 'landline',
          dnc_listed: true,
          tcpa_flag: false,
          rank: 2,
        },
        {
          e164: '+14015550100',
          kind: 'mobile',
          dnc_listed: false,
          tcpa_flag: false,
          rank: 1,
        },
      ],
      emails: [
        { address: 'jane.roe@example.com', rank: 1 },
      ],
      credits_used: 5,
      matched_owner: true,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: null,
    },
    trigger: null,
    scores: null,
    provenance: {
      adapter: 'enricher',
      adapter_version: '1.0.0',
      confidence: 0.9,
    },
  };
}

