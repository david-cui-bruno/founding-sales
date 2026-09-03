import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { CloudOutcomeRow, SuppressionOutboxRow } from '../../../src/main/domain/founderSalesDomain';
import { suppressionUploadLineSchema } from '../../../src/shared/contracts/suppressionUploadContract';
import {
  UpstreamSync,
  contactHmac,
  membershipUploadSchema,
  outcomeUploadLineSchema,
  type UpstreamObjectStore,
} from '../../../src/main/sourcing/upstreamSync';

const NOW = '2026-09-01T12:00:00.000Z';
const CE_A = 'ce_01JC0000000000000000000000';
const CE_B = 'ce_01JC0000000000000000000001';

type FakeDomain = {
  listCloudMembership: ReturnType<typeof vi.fn>;
  listUnflushedCloudOutcomes: ReturnType<typeof vi.fn>;
  markCloudOutcomesFlushed: ReturnType<typeof vi.fn>;
  listUnflushedSuppressionHandles: ReturnType<typeof vi.fn>;
  markSuppressionHandlesFlushed: ReturnType<typeof vi.fn>;
};

function fakeDomain(overrides: Partial<{
  membership: {
    cloudEntityIds: string[];
    manualContacts: { kind: 'phone' | 'email'; normalizedValue: string }[];
  };
  outcomes: CloudOutcomeRow[];
  suppressions: SuppressionOutboxRow[];
}> = {}): { gate: { withDomain<T>(operation: (domain: FakeDomain) => T): Promise<T> }; domain: FakeDomain } {
  const domain: FakeDomain = {
    listCloudMembership: vi.fn(() => overrides.membership ?? {
      cloudEntityIds: [], manualContacts: [],
    }),
    listUnflushedCloudOutcomes: vi.fn(() => overrides.outcomes ?? []),
    markCloudOutcomesFlushed: vi.fn(),
    listUnflushedSuppressionHandles: vi.fn(() => overrides.suppressions ?? []),
    markSuppressionHandlesFlushed: vi.fn(),
  };
  return {
    gate: { withDomain: async (operation) => operation(domain) },
    domain,
  };
}

function fakeStore(): { store: UpstreamObjectStore; puts: { key: string; body: string; contentType: string }[] } {
  const puts: { key: string; body: string; contentType: string }[] = [];
  return {
    store: {
      putObjectText: async (input) => {
        puts.push(input);
      },
    },
    puts,
  };
}

function buildSync(input: {
  gate: { withDomain<T>(operation: (domain: FakeDomain) => T): Promise<T> };
  salt?: string | null;
}): UpstreamSync {
  return new UpstreamSync({
    domainGate: input.gate as never,
    loadHmacSalt: async () => input.salt ?? null,
    clock: { now: () => NOW },
  });
}

describe('UpstreamSync', () => {
  it('uploads membership with salted contact HMACs when the salt is set', async () => {
    const { gate } = fakeDomain({
      membership: {
        cloudEntityIds: [CE_A, CE_B],
        manualContacts: [
          { kind: 'email', normalizedValue: 'Manual@Example.com ' },
          { kind: 'phone', normalizedValue: '+14015550100' },
        ],
      },
    });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate, salt: 'shared-salt' }).run(store);

    expect(report.membershipUploaded).toBe(true);
    const upload = puts.find((put) => put.key === 'upstream/membership/2026-09-01.json');
    expect(upload).toBeDefined();
    expect(upload!.contentType).toBe('application/json');
    const body = membershipUploadSchema.parse(JSON.parse(upload!.body));
    expect(body.cloud_entity_ids).toEqual([CE_A, CE_B]);
    // HMAC-SHA256(lowercased trimmed email / E.164 phone) with the shared
    // salt, lowercase hex. Never the cleartext handles.
    expect(body.contact_hmacs).toHaveLength(2);
    for (const hmac of body.contact_hmacs!) {
      expect(hmac).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(upload!.body).not.toContain('manual@example.com');
    expect(upload!.body).not.toContain('+14015550100');
  });

  it('omits contact_hmacs entirely when no salt is provisioned', async () => {
    const { gate } = fakeDomain({
      membership: {
        cloudEntityIds: [CE_A],
        manualContacts: [{ kind: 'phone', normalizedValue: '+14015550100' }],
      },
    });
    const { store, puts } = fakeStore();

    await buildSync({ gate, salt: null }).run(store);

    const upload = puts.find((put) => put.key.startsWith('upstream/membership/'));
    const parsed = JSON.parse(upload!.body) as Record<string, unknown>;
    expect(parsed).toEqual({ cloud_entity_ids: [CE_A] });
  });

  it('skips the membership upload when there is nothing to report', async () => {
    const { gate } = fakeDomain();
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate }).run(store);

    expect(report.membershipUploaded).toBe(false);
    expect(puts).toEqual([]);
  });

  it('flushes unflushed outcomes as strict ndjson and marks them flushed', async () => {
    const outcomes: CloudOutcomeRow[] = [
      {
        id: 'stage:event-1', cloudEntityId: CE_A, label: 'interviewed',
        lossReasonCode: null, overrideDirection: null, observedAt: NOW,
      },
      {
        id: 'override-1', cloudEntityId: CE_B, label: 'override',
        lossReasonCode: null, overrideDirection: 'down', observedAt: NOW,
      },
    ];
    const { gate, domain } = fakeDomain({ outcomes });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate }).run(store);

    expect(report.outcomesFlushed).toBe(2);
    const upload = puts.find((put) => put.key === 'upstream/outcomes/2026-09-01.ndjson');
    expect(upload).toBeDefined();
    expect(upload!.contentType).toBe('application/x-ndjson');
    const lines = upload!.body.trim().split('\n').map(
      (line) => outcomeUploadLineSchema.parse(JSON.parse(line)),
    );
    expect(lines).toEqual([
      {
        cloud_entity_id: CE_A, label: 'interviewed',
        loss_reason_code: null, override_direction: null, observed_at: NOW,
      },
      {
        cloud_entity_id: CE_B, label: 'override',
        loss_reason_code: null, override_direction: 'down', observed_at: NOW,
      },
    ]);
    expect(domain.markCloudOutcomesFlushed).toHaveBeenCalledWith({
      ids: ['stage:event-1', 'override-1'],
    });
  });

  it('never marks outcomes flushed when the upload fails', async () => {
    const outcomes: CloudOutcomeRow[] = [{
      id: 'stage:event-1', cloudEntityId: CE_A, label: 'won',
      lossReasonCode: null, overrideDirection: null, observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ outcomes });
    const store: UpstreamObjectStore = {
      putObjectText: async () => {
        throw new Error('AccessDenied');
      },
    };

    await expect(buildSync({ gate }).run(store)).rejects.toThrow('AccessDenied');
    expect(domain.markCloudOutcomesFlushed).not.toHaveBeenCalled();
  });

  it('rejects an outcome row whose reason code is not a closed enum value', () => {
    expect(() => outcomeUploadLineSchema.parse({
      cloud_entity_id: CE_A,
      label: 'lost',
      loss_reason_code: 'free text about a person',
      override_direction: null,
      observed_at: NOW,
    })).toThrow();
  });

  it('is deterministic: identical handles produce identical hmacs across runs', async () => {
    const membership = {
      cloudEntityIds: [CE_A],
      manualContacts: [{ kind: 'email' as const, normalizedValue: 'a@b.com' }],
    };
    const first = fakeStore();
    const second = fakeStore();
    await buildSync({ gate: fakeDomain({ membership }).gate, salt: 's' }).run(first.store);
    await buildSync({ gate: fakeDomain({ membership }).gate, salt: 's' }).run(second.store);

    expect(first.puts[0]!.body).toBe(second.puts[0]!.body);
  });

  it('uploads suppression handles as salted-HMAC ndjson and marks them flushed', async () => {
    const suppressions: SuppressionOutboxRow[] = [
      {
        handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
        reason: 'founder_block', observedAt: NOW,
      },
      {
        handleId: 'handle-2', kind: 'email', normalizedValue: 'owner@example.com',
        reason: 'opt_out', observedAt: NOW,
      },
    ];
    const { gate, domain } = fakeDomain({ suppressions });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate, salt: 'shared-salt' }).run(store);

    expect(report.suppressionsFlushed).toBe(2);
    const upload = puts.find((put) => put.key === 'upstream/suppressions/2026-09-01.ndjson');
    expect(upload).toBeDefined();
    expect(upload!.contentType).toBe('application/x-ndjson');
    const lines = upload!.body.trim().split('\n').map(
      (line) => suppressionUploadLineSchema.parse(JSON.parse(line)),
    );
    // The line HMACs must use the EXACT contactHmac canonicalization the
    // membership upload uses, keyed with the same shared salt.
    expect(lines).toEqual([
      {
        contact_hmac: contactHmac({
          salt: 'shared-salt', kind: 'phone', normalizedValue: '+14015550100',
        }),
        kind: 'phone', reason: 'founder_block', observed_at: NOW,
      },
      {
        contact_hmac: contactHmac({
          salt: 'shared-salt', kind: 'email', normalizedValue: 'owner@example.com',
        }),
        kind: 'email', reason: 'opt_out', observed_at: NOW,
      },
    ]);
    expect(upload!.body).not.toContain('+14015550100');
    expect(upload!.body).not.toContain('owner@example.com');
    expect(domain.markSuppressionHandlesFlushed).toHaveBeenCalledWith({
      handleIds: ['handle-1', 'handle-2'],
    });
  });

  it('matches the pinned HMAC vector so cloud and app hashes agree', () => {
    // createHmac('sha256', 'salt').update('+14015550100').digest('hex')
    expect(contactHmac({
      salt: 'salt', kind: 'phone', normalizedValue: '+14015550100',
    })).toBe(createHmac('sha256', 'salt').update('+14015550100', 'utf8').digest('hex'));
    // Emails are lowercased and trimmed before hashing.
    expect(contactHmac({
      salt: 'salt', kind: 'email', normalizedValue: ' Owner@Example.com ',
    })).toBe(createHmac('sha256', 'salt').update('owner@example.com', 'utf8').digest('hex'));
  });

  it('SKIPS the suppression step entirely when no salt is provisioned', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ suppressions });
    const { store, puts } = fakeStore();

    const report = await buildSync({ gate, salt: null }).run(store);

    expect(report.suppressionsFlushed).toBe(0);
    expect(puts.some((put) => put.key.startsWith('upstream/suppressions/'))).toBe(false);
    // Never listed, never flushed: the rows retry once a salt exists.
    expect(domain.listUnflushedSuppressionHandles).not.toHaveBeenCalled();
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();
  });

  it('never marks suppressions flushed when the upload fails', async () => {
    const suppressions: SuppressionOutboxRow[] = [{
      handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
      reason: 'opt_out', observedAt: NOW,
    }];
    const { gate, domain } = fakeDomain({ suppressions });
    const store: UpstreamObjectStore = {
      putObjectText: async ({ key }) => {
        if (key.startsWith('upstream/suppressions/')) {
          throw new Error('AccessDenied');
        }
      },
    };

    await expect(buildSync({ gate, salt: 's' }).run(store)).rejects.toThrow('AccessDenied');
    expect(domain.markSuppressionHandlesFlushed).not.toHaveBeenCalled();
  });
});
