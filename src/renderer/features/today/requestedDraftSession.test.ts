import { setDailySessionScope } from './dailySessionScope';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestedDraftSession,
  type RequestedDraftApi,
} from './requestedDraftSession';
import type {
  SavedRequestedFollowup,
  EditRequestedFollowup,
} from '../../../shared/contracts/requestedFollowupContract';
import { requestedDraft } from './nativeDesk.fixture';
const saved = (): SavedRequestedFollowup => ({
  draft: requestedDraft(),
  stale: false,
  approval: null,
});
function apiFixture() {
  const api = {
    getRequestedFollowup: vi.fn(async () => saved()),
    editRequestedFollowup: vi.fn(async (input: EditRequestedFollowup) => ({
      draft: {
        ...requestedDraft(),
        revision: input.expectedRevision + 1,
        subject: input.subject,
        body: input.body,
      },
      stale: false,
      approval: null,
    })),
    approveRequestedFollowup: vi.fn(async () => ({
      state: 'pending_preflight',
      receipt: {
        commandId: 'receipt',
        status: 'pending',
        authorityGeneration: 1,
        aggregateVersion: 1,
        reason: null,
      },
      intentCommandId: null,
      reason: null,
    })),
  } as unknown as RequestedDraftApi;
  return api;
}
describe('requested email durable session', () => {
  it('does not call getter on creation/ingestion and preserves newer edits through in-flight save', async () => {
    const api = apiFixture();
    const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
    s.edit('body', 'first');
    let resolve!: (v: ReturnType<typeof saved>) => void;
    vi.mocked(api.editRequestedFollowup).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const saving = s.flush();
    s.edit('body', 'second');
    resolve({
      ...saved(),
      draft: { ...requestedDraft(), revision: 2, body: 'first' },
    });
    await saving;
    expect(s.snapshot().body).toBe('second');
    expect(s.snapshot().draft.body).toBe('second');
    expect(api.getRequestedFollowup).not.toHaveBeenCalled();
  });
  it('approval first obtains a canonical remote acknowledgement even for unchanged draft, then uses exact revision', async () => {
    const api = apiFixture();
    const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
    await s.approve('2026-09-10T12:00:00.000Z', true);
    expect(api.editRequestedFollowup).toHaveBeenCalledTimes(1);
    expect(api.approveRequestedFollowup).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          revision: 2,
          body: 'Saved note for a',
        }),
        expectedRemoteDraftRevision: 2,
        expiresAt: '2026-09-10T12:00:00.000Z',
        request: {
          statement: 'recipient_requested_information_by_email',
          recipient: 'a@fixture.invalid',
        },
      }),
    );
    expect(s.snapshot().approval?.state).toBe('pending_preflight');
  });
  it('failed save blocks approval but explicit preflight recovers without flushing local edits', async () => {
    const api = apiFixture();
    vi.mocked(api.editRequestedFollowup).mockRejectedValue(Error('offline'));
    const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
    s.edit('body', 'local');
    await s.approve('2026-09-10T12:00:00.000Z', true);
    expect(api.approveRequestedFollowup).not.toHaveBeenCalled();
    await s.preflight();
    expect(s.snapshot().body).toBe('local');
    expect(api.getRequestedFollowup).toHaveBeenCalledTimes(1);
  });
  it('holds changed recipient/context/revision with local edits intact', async () => {
    const api = apiFixture();
    const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
    s.edit('body', 'local');
    s.ingest({ ...requestedDraft(), revision: 2, body: 'elsewhere' }, null);
    expect(s.snapshot().conflict).toBe(true);
    expect(s.snapshot().body).toBe('local');
    await s.approve('2026-09-10T12:00:00.000Z', true);
    expect(api.editRequestedFollowup).not.toHaveBeenCalled();
  });
  it('retains exact approval command after unknown failure, never automatically replays', async () => {
    const api = apiFixture();
    vi.mocked(api.approveRequestedFollowup).mockRejectedValue(Error('unknown'));
    const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
    await s.approve('2026-09-10T12:00:00.000Z', true);
    const request = vi.mocked(api.approveRequestedFollowup).mock.calls[0]![0];
    await s.preflight();
    expect(api.approveRequestedFollowup).toHaveBeenCalledTimes(1);
    await s.retryApproval();
    expect(vi.mocked(api.approveRequestedFollowup).mock.calls[1]![0]).toEqual(
      request,
    );
  });
});
it('isolates recipient identities while preserving earlier local edits for return', () => {
  const api = apiFixture(),
    original = requestedDraft();
  const first = requestedDraftSession(api, 'ws', original, null);
  first.edit('body', 'Original recipient edits');
  const changed = {
    ...original,
    recipient: 'other@fixture.invalid',
    recipientBinding: {
      ...original.recipientBinding,
      email: 'other@fixture.invalid',
    },
  };
  const next = requestedDraftSession(api, 'ws', changed, null);
  expect(next).not.toBe(first);
  expect(next.snapshot().conflict).toBe(true);
  next.useSavedVersion();
  next.edit('body', 'New recipient edits');
  expect(requestedDraftSession(api, 'ws', original, null).snapshot().body).toBe(
    'Original recipient edits',
  );
});

beforeEach(() =>
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-09T00:00:00Z')),
);
afterEach(() => vi.restoreAllMocks());

it('does not revive approval after teardown and same-workspace reopen during save', async () => {
  const api = apiFixture();
  setDailySessionScope(api, 'ws');
  let resolve!: (v: ReturnType<typeof saved>) => void;
  vi.mocked(api.editRequestedFollowup).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
  const pending = s.approve('2026-09-10T12:00:00.000Z', true);
  setDailySessionScope(api, null);
  setDailySessionScope(api, 'ws');
  resolve({ ...saved(), draft: { ...requestedDraft(), revision: 2 } });
  await pending;
  expect(api.approveRequestedFollowup).not.toHaveBeenCalled();
});
it.each(['refresh', 'held'] as const)(
  'approval continuation respects %s without losing canonical saved text',
  async (kind) => {
    const api = apiFixture();
    setDailySessionScope(api, 'ws');
    const s = requestedDraftSession(api, 'ws', requestedDraft(), null);
    let resolve!: (v: ReturnType<typeof saved>) => void;
    vi.mocked(api.editRequestedFollowup).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = s.approve('2026-09-10T12:00:00.000Z', true);
    if (kind === 'held') {
      s.setActionHold('Paused');
      s.setActionHold(undefined);
    } else setDailySessionScope(api, 'ws');
    resolve({ ...saved(), draft: { ...requestedDraft(), revision: 2 } });
    await pending;
    expect(api.approveRequestedFollowup).toHaveBeenCalledTimes(
      kind === 'refresh' ? 1 : 0,
    );
    expect(s.snapshot().body).toBe(requestedDraft().body);
  },
);
