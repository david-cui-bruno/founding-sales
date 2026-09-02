import { describe, expect, it } from 'vitest';

import {
  cloudChannelSchema,
  cloudSourceEventSchema,
  validateCloudSourceEvent,
  type CloudSourceEvent,
} from '../../../src/shared/contracts/cloudSourceEventContract';
import { validFrboEvent, validParcelEvent, validEnrichmentEvent } from '../../fixtures/cloudSourceEvents';

describe('cloudSourceEventContract (local mirror)', () => {
  it('round-trips a valid frbo event', () => {
    const event = validFrboEvent();
    const parsed = cloudSourceEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  it('accepts a person-bearing parcel event through full validation', () => {
    const result = validateCloudSourceEvent(validParcelEvent());
    expect(result.success).toBe(true);
  });

  it('round-trips a real cloud-shaped enrichment event on channel parcel', () => {
    const event = validEnrichmentEvent();
    const result = validateCloudSourceEvent(JSON.parse(JSON.stringify(event)));
    expect(result.success).toBe(true);
    if (result.success === false) return;
    expect(result.data).toEqual(event);
  });

  it('rejects an enrichment phone with a non-E.164 number', () => {
    const dirty = JSON.parse(JSON.stringify(validEnrichmentEvent())) as {
      payload: { phones: Array<Record<string, unknown>> };
    };
    dirty.payload.phones[0]!.e164 = '4015550100';
    expect(validateCloudSourceEvent(dirty).success).toBe(false);
  });

  it('rejects an enrichment email with uppercase characters', () => {
    const dirty = JSON.parse(JSON.stringify(validEnrichmentEvent())) as {
      payload: { emails: Array<Record<string, unknown>> };
    };
    dirty.payload.emails[0]!.address = 'Jane.Roe@example.com';
    expect(validateCloudSourceEvent(dirty).success).toBe(false);
  });

  it('rejects an enrichment phone missing its DNC flag (strict)', () => {
    const dirty = JSON.parse(JSON.stringify(validEnrichmentEvent())) as {
      payload: { phones: Array<Record<string, unknown>> };
    };
    delete dirty.payload.phones[0]!.dnc_listed;
    expect(validateCloudSourceEvent(dirty).success).toBe(false);
  });

  it('rejects an enrichment payload with rank 0 or a wrong vendor', () => {
    const badRank = JSON.parse(JSON.stringify(validEnrichmentEvent())) as {
      payload: { phones: Array<Record<string, unknown>> };
    };
    badRank.payload.phones[0]!.rank = 0;
    expect(validateCloudSourceEvent(badRank).success).toBe(false);

    const badVendor = JSON.parse(JSON.stringify(validEnrichmentEvent())) as {
      payload: Record<string, unknown>;
    };
    badVendor.payload.vendor = 'otherco';
    expect(validateCloudSourceEvent(badVendor).success).toBe(false);
  });

  it('still rejects a parcel payload matching neither union member', () => {
    const dirty = JSON.parse(JSON.stringify(validParcelEvent())) as {
      payload: Record<string, unknown>;
    };
    dirty.payload.extra_field = true;
    expect(validateCloudSourceEvent(dirty).success).toBe(false);
  });

  it('lists every 0005 channel', () => {
    expect([...cloudChannelSchema.options].sort()).toEqual([
      'community', 'custom', 'deed', 'frbo', 'inbound_demo', 'parcel',
      'permit', 'referral', 'registry', 'rireig', 'violation',
    ]);
  });

  it('rejects unknown top-level fields (strict)', () => {
    const event = { ...validFrboEvent(), sneaky_note: 'prose about a person' };
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects unknown nested entity fields (strict)', () => {
    const dirty = JSON.parse(JSON.stringify(validFrboEvent())) as Record<string, unknown>;
    (dirty.entity as Record<string, unknown>).bio = 'free text';
    expect(cloudSourceEventSchema.safeParse(dirty).success).toBe(false);
  });

  it('rejects a wrong contract version', () => {
    const event = { ...validFrboEvent(), contract_version: 2 };
    expect(cloudSourceEventSchema.safeParse(event).success).toBe(false);
  });

  it('accepts the optional scores_version as an integer >= 1', () => {
    const scored: CloudSourceEvent = {
      ...validFrboEvent(),
      scores: {
        fit: 62,
        timing: 41,
        reasons: [{ signal: 'portfolio_in_band', contribution: 15 }],
      },
      scores_version: 1,
    };
    expect(validateCloudSourceEvent(scored).success).toBe(true);

    expect(cloudSourceEventSchema.safeParse({
      ...scored, scores_version: 0,
    }).success).toBe(false);
    expect(cloudSourceEventSchema.safeParse({
      ...scored, scores_version: 1.5,
    }).success).toBe(false);
  });

  it('bounds score reasons to 1..3 entries', () => {
    const base = validFrboEvent();
    const reason = { signal: 'pre_1940_stock', contribution: 8 };
    expect(cloudSourceEventSchema.safeParse({
      ...base, scores: { fit: 10, timing: 10, reasons: [] },
    }).success).toBe(false);
    expect(cloudSourceEventSchema.safeParse({
      ...base, scores: { fit: 10, timing: 10, reasons: [reason, reason, reason, reason] },
    }).success).toBe(false);
    expect(cloudSourceEventSchema.safeParse({
      ...base, scores: { fit: 10, timing: 10, reasons: [reason, reason, reason] },
    }).success).toBe(true);
  });

  it('rejects a payload that does not match the channel schema', () => {
    const event = validFrboEvent();
    event.payload = {
      platform: 'reddit',
      topic_keywords: ['landlord'],
      post_url: 'https://www.reddit.com/r/providence/comments/x',
    };
    const result = validateCloudSourceEvent(event);
    expect(result.success).toBe(false);
    if (result.success === false) expect(result.error).toContain('frbo');
  });

  it('rejects channels without a registered payload schema', () => {
    const event: CloudSourceEvent = { ...validFrboEvent(), channel: 'registry' };
    const result = validateCloudSourceEvent(event);
    expect(result.success).toBe(false);
    if (result.success === false) expect(result.error).toContain('registry');
  });

  it('rejects malformed ids, idempotency keys, and phones', () => {
    expect(cloudSourceEventSchema.safeParse({
      ...validFrboEvent(), id: 'se_lowercase00000000000000000',
    }).success).toBe(false);
    expect(cloudSourceEventSchema.safeParse({
      ...validFrboEvent(), idempotency_key: 'xyz',
    }).success).toBe(false);
    const badPhone = JSON.parse(JSON.stringify(validParcelEvent())) as CloudSourceEvent;
    (badPhone.entity.person as { phones: string[] }).phones = ['401-555-1234'];
    expect(cloudSourceEventSchema.safeParse(badPhone).success).toBe(false);
  });
});
