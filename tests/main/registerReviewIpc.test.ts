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
  type ResolveReviewRequest,
  type ReviewListRequest,
  type ReviewSnapshot,
} from '../../src/shared/contracts/reviewContract';
import { registerReviewIpc } from '../../src/main/review/registerReviewIpc';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const trustedEvent = { senderFrame: { url: 'callie://app/index.html' } };
const untrustedEvent = { senderFrame: { url: 'https://attacker.test/' } };

const emptySnapshot: ReviewSnapshot = {
  items: [],
  totalOpenCount: 0,
  revision: 0,
};

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
