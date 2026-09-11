import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: electron.handle,
    removeHandler: electron.removeHandler,
  },
}));

import type { MutationReceipt } from '../../src/shared/contracts/commonContract';
import {
  resolveReviewRequestSchema,
  reviewListRequestSchema,
  reviewSnapshotSchema,
  type ResolveReviewRequest,
  type ReviewListRequest,
  type ReviewSnapshot,
} from '../../src/shared/contracts/reviewContract';
import { registerReviewIpc } from '../../src/main/review/registerReviewIpc';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const trustedEvent = { senderFrame: { url: 'callie://app/index.html' } };
const untrustedEvent = { senderFrame: { url: 'https://attacker.test/' } };

const emptySnapshot: ReviewSnapshot = reliabilityCompleteSnapshot();

const receipt: MutationReceipt = {
  revision: 3,
  affectedPersonIds: ['person-kevin'],
  affectedSalesCycleIds: [],
};

const listRequest: ReviewListRequest = { kinds: [], limit: 50 };

const acceptRequest: ResolveReviewRequest = {
  kind: 'transcript_suggestion',
  reviewId: 'review-1',
  expectedVersion: 1,
  action: 'accept',
  editedValue: null,
};

function createProvider() {
  return {
    list: vi.fn(async () => emptySnapshot),
    resolve: vi.fn(async () => receipt),
  };
}

function listHandler() {
  return registeredIpcHandler(electron.handle, 'review:list');
}

function resolveHandler() {
  return registeredIpcHandler(electron.handle, 'review:resolve');
}

describe('resolveReviewRequestSchema', () => {
  it('rejects a resolution payload for the wrong review kind', () => {
    expect(() => resolveReviewRequestSchema.parse({
      kind: 'transcript_suggestion', reviewId: 'review-1', action: 'mark_personal', normalizedHandle: '+14015550100',
    })).toThrow();
  });

  it('rejects an unknown review kind discriminator', () => {
    expect(() => resolveReviewRequestSchema.parse({
      kind: 'coffee_request', reviewId: 'review-1', expectedVersion: 1, action: 'accept',
    })).toThrow();
  });
});

describe('registerReviewIpc', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('registers exactly review:list and review:resolve', () => {
    registerReviewIpc(createProvider());

    expect(electron.handle).toHaveBeenCalledTimes(2);
    expect(electron.handle.mock.calls.map((call) => call[0]).sort()).toEqual([
      'review:list', 'review:resolve',
    ]);
  });

  it('returns the validated snapshot for a trusted list request', async () => {
    const provider = createProvider();
    registerReviewIpc(provider);

    await expect(listHandler()(trustedEvent, listRequest)).resolves.toEqual(emptySnapshot);
    expect(provider.list).toHaveBeenCalledTimes(1);
    expect(provider.list).toHaveBeenCalledWith(listRequest);
  });

  it('rejects an untrusted sender on both channels before the provider runs', async () => {
    const provider = createProvider();
    registerReviewIpc(provider);

    await expect(listHandler()(untrustedEvent, listRequest)).rejects.toThrow('trusted');
    await expect(resolveHandler()(untrustedEvent, acceptRequest)).rejects.toThrow('trusted');
    expect(provider.list).not.toHaveBeenCalled();
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('rejects a malformed list request before invoking the provider', async () => {
    const provider = createProvider();
    registerReviewIpc(provider);

    await expect(listHandler()(trustedEvent, { kinds: [], limit: 0 })).rejects.toThrow();
    await expect(
      listHandler()(trustedEvent, { kinds: [], limit: 50, score: 90 }),
    ).rejects.toThrow();
    expect(provider.list).not.toHaveBeenCalled();
  });

  it('rejects a cross-kind resolution payload before invoking the provider', async () => {
    const provider = createProvider();
    registerReviewIpc(provider);

    await expect(resolveHandler()(trustedEvent, {
      kind: 'transcript_suggestion', reviewId: 'review-1',
      action: 'mark_personal', normalizedHandle: '+14015550100',
    })).rejects.toThrow();
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it('resolves a valid discriminated request and returns the validated receipt', async () => {
    const provider = createProvider();
    registerReviewIpc(provider);

    await expect(resolveHandler()(trustedEvent, acceptRequest)).resolves.toEqual(receipt);
    expect(provider.resolve).toHaveBeenCalledTimes(1);
    expect(provider.resolve).toHaveBeenCalledWith(acceptRequest);
  });

  it('rejects a malformed provider snapshot in the main process', async () => {
    const provider = {
      list: vi.fn(async () => ({ ...emptySnapshot, totalOpenCount: -1 })),
      resolve: vi.fn(async () => receipt),
    };
    registerReviewIpc(provider);

    await expect(listHandler()(trustedEvent, listRequest)).rejects.toThrow();
  });

  it('rejects a provider receipt that smuggles extra fields', async () => {
    const provider = {
      list: vi.fn(async () => emptySnapshot),
      resolve: vi.fn(async () => ({ ...receipt, internalPath: '/tmp/workspace.db' })),
    };
    registerReviewIpc(provider);

    await expect(resolveHandler()(trustedEvent, acceptRequest)).rejects.toThrow();
  });

  it('removes both review handlers exactly once', () => {
    const unregister = registerReviewIpc(createProvider());

    unregister();
    unregister();

    expect(electron.removeHandler).toHaveBeenCalledTimes(2);
    expect(electron.removeHandler.mock.calls.map((call) => call[0]).sort()).toEqual([
      'review:list', 'review:resolve',
    ]);
  });
});

// Synthetic provider DTO. The real registrar must validate it before delivery.
function reliabilityCompleteSnapshot(): ReviewSnapshot {
  return {
    items: [], totalOpenCount: 0, revision: 0,
    nextCursor: null, matchedCount: 0,
    countScope: 'lifecycle_review_items' as const,
    observedAt: '2026-09-10T00:00:00.000Z',
    queues: {
      unmatched_communication: { source: 'lifecycle_review_items' as const, openCount: 0 },
      system_error: { source: 'lifecycle_review_items' as const, openCount: 0 },
      ambiguous_identity: { source: 'not_integrated' as const, openCount: null },
      transcript_suggestion: { source: 'not_integrated' as const, openCount: null },
      import_problem: { source: 'not_integrated' as const, openCount: null },
      adapter_failure: { source: 'not_integrated' as const, openCount: null },
    },
  };
}

describe('reliability: strict review read boundary', () => {
  beforeEach(() => {
    electron.handle.mockReset();
    electron.removeHandler.mockReset();
  });

  it('does not deliver a legacy snapshot that cannot describe complete queue availability', async () => {
    const legacy = reliabilityCompleteSnapshot();
    // Deliberately malformed external provider response, without a type escape.
    for (const key of ['nextCursor', 'matchedCount', 'queues', 'countScope', 'observedAt']) {
      Reflect.deleteProperty(legacy, key);
    }
    registerReviewIpc({ list: async () => legacy, resolve: async () => receipt });
    await expect(listHandler()(trustedEvent, listRequest)).rejects.toThrow();
  });

  it('delivers complete metadata through the actual registrar with an explicit first-page cursor', async () => {
    registerReviewIpc({
      list: async () => reliabilityCompleteSnapshot(),
      resolve: async () => receipt,
    });
    await expect(listHandler()(trustedEvent, { kinds: [], cursor: null, limit: 1 }))
      .resolves.toMatchObject({
        items: [], totalOpenCount: 0, matchedCount: 0, nextCursor: null,
        countScope: 'lifecycle_review_items', observedAt: '2026-09-10T00:00:00.000Z',
        queues: {
          unmatched_communication: { source: 'lifecycle_review_items', openCount: 0 },
          system_error: { source: 'lifecycle_review_items', openCount: 0 },
          ambiguous_identity: { source: 'not_integrated', openCount: null },
          transcript_suggestion: { source: 'not_integrated', openCount: null },
          import_problem: { source: 'not_integrated', openCount: null },
          adapter_failure: { source: 'not_integrated', openCount: null },
        },
      });
  });

  it('keeps omitted cursor compatibility and accepts only bounded string or null cursor inputs', () => {
    expect(reviewListRequestSchema.safeParse({ kinds: [], limit: 1 }).success).toBe(true);
    expect(reviewListRequestSchema.safeParse({ kinds: [], limit: 1, cursor: null }).success).toBe(true);
    expect(reviewListRequestSchema.safeParse({ kinds: [], limit: 200, cursor: 'a'.repeat(1024) }).success).toBe(true);
    for (const cursor of [7, {}, 'a'.repeat(1025)]) {
      expect(reviewListRequestSchema.safeParse({ kinds: [], limit: 1, cursor }).success).toBe(false);
    }
    // Opaque-string syntax is validated by domain/helper, not this transport schema.
  });

  it.each([
    'unmatched_communication', 'system_error', 'ambiguous_identity',
    'transcript_suggestion', 'import_problem', 'adapter_failure',
  ])('rejects missing %s availability instead of defaulting to zero', key => {
    const snapshot = reliabilityCompleteSnapshot();
    Reflect.deleteProperty(snapshot.queues, key);
    expect(reviewSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });

  it.each([
    { source: 'not_integrated', openCount: 0 },
    { source: 'lifecycle_review_items', openCount: null },
    { source: 'lifecycle_review_items', openCount: -1 },
    { source: 'lifecycle_review_items', openCount: 1.5 },
    { source: 'lifecycle_review_items', openCount: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects inconsistent or unsafe queue metadata: %j', invalidQueue => {
    const snapshot = reliabilityCompleteSnapshot();
    const invalid = { ...snapshot, queues: { ...snapshot.queues, system_error: invalidQueue } };
    expect(reviewSnapshotSchema.safeParse(invalid).success).toBe(false);
  });

  it('still rejects an untrusted summary read before reaching the provider', async () => {
    const provider = {
      list: vi.fn(async () => reliabilityCompleteSnapshot()),
      resolve: vi.fn(async () => receipt),
    };
    registerReviewIpc(provider);
    await expect(listHandler()(untrustedEvent, { kinds: [], cursor: null, limit: 1 }))
      .rejects.toThrow('trusted');
    expect(provider.list).not.toHaveBeenCalled();
  });
});
