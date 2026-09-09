import { setDailySessionScope } from '../today/dailySessionScope';
import { expect, it, vi } from 'vitest';
import { linkedInSession } from './linkedInSession';
import { linkedInFixture } from '../today/nativeDesk.fixture';
import type { LinkedInApi } from '../../../shared/contracts/linkedInContract';
const commandId = '11111111-1111-4111-8111-111111111111';
const receipt = (
  status: 'pending' | 'applied' | 'rejected',
  id = commandId,
) => ({
  commandId: id,
  status,
  authorityGeneration: 1,
  aggregateVersion: 1,
  reason: null as null,
});
it.each(['applied', 'rejected'] as const)(
  'explicitly replays exact pending outcome to %s',
  async (status) => {
    const item = linkedInFixture();
    item.recovery.started = true;
    const api = {
      reportOutcome: vi.fn(
        async (input: Parameters<LinkedInApi['reportOutcome']>[0]) => ({
          draftId: item.draft.id,
          revision: 1,
          receipt: receipt('pending', input.commandId),
        }),
      ),
    } as unknown as LinkedInApi;
    const s = linkedInSession(api, 'ws', item);
    await s.report('not_sent', '');
    const original = vi.mocked(api.reportOutcome).mock.calls[0]![0];
    vi.mocked(api.reportOutcome).mockResolvedValueOnce({
      draftId: item.draft.id,
      revision: 1,
      receipt: receipt(status, original.commandId),
    });
    await s.report('not_sent', '');
    expect(api.reportOutcome).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.reportOutcome).mock.calls[1]![0]).toEqual(original);
    expect(s.snapshot().report?.receipt.status).toBe(status);
    expect(s.canReport()).toBe(false);
  },
);
it('terminal recovered begin rejection allows explicit newer version review', () => {
  const item = linkedInFixture();
  item.recovery.approvalCommandId = commandId;
  item.recovery.attempts = [{ commandId, receipt: receipt('rejected') }];
  const s = linkedInSession({} as LinkedInApi, 'ws', item);
  s.ingest({
    ...item,
    draft: { ...item.draft, revision: 2, body: 'New saved' },
    recovery: {
      ...item.recovery,
      revision: 2,
      approvalCommandId: null,
      attempts: [],
    },
  });
  expect(s.canUseSavedVersion()).toBe(true);
  expect(s.snapshot().body).toBe(item.draft.body);
  s.useSavedVersion();
  expect(s.snapshot().body).toBe('New saved');
});
it('recovers historical begin receipt without requiring obsolete draft get', async () => {
  const item = linkedInFixture();
  item.recovery.approvalCommandId = commandId;
  item.recovery.attempts = [{ commandId, receipt: null }];
  const api = {
    get: vi.fn(async () => {
      throw Error('stale_draft');
    }),
    recover: vi.fn(async () => ({
      ...item.recovery,
      attempts: [{ commandId, receipt: receipt('rejected') }],
    })),
  } as unknown as LinkedInApi;
  const s = linkedInSession(api, 'ws', item);
  s.ingest({
    ...item,
    draft: { ...item.draft, revision: 2 },
    recovery: {
      ...item.recovery,
      revision: 2,
      approvalCommandId: null,
      attempts: [],
    },
  });
  expect(s.canUseSavedVersion()).toBe(false);
  await s.recover();
  expect(api.recover).toHaveBeenCalledWith({
    draftId: item.draft.id,
    expectedRevision: 1,
  });
  expect(s.canUseSavedVersion()).toBe(true);
  expect(s.snapshot().conflict).toBe(true);
});
it('terminal historical recovery supersedes this renderer pending begin receipt', async () => {
  const item = linkedInFixture();
  const api = {
    begin: vi.fn(async (input: Parameters<LinkedInApi['begin']>[0]) => ({
      draftId: item.draft.id,
      revision: 1,
      receipt: receipt('pending', input.commandId),
      handoffId: null,
      status: 'pending',
    })),
    recover: vi.fn(),
  } as unknown as LinkedInApi;
  const s = linkedInSession(api, 'ws', item);
  await s.begin();
  const id = vi.mocked(api.begin).mock.calls[0]![0].commandId;
  s.ingest({
    ...item,
    draft: { ...item.draft, revision: 2 },
    recovery: { ...item.recovery, revision: 2 },
  });
  vi.mocked(api.recover).mockResolvedValue({
    ...item.recovery,
    approvalCommandId: id,
    attempts: [{ commandId: id, receipt: receipt('rejected', id) }],
  });
  await s.recover();
  expect(s.canUseSavedVersion()).toBe(true);
});
it.each(['pending', 'unknown', 'mismatched'] as const)(
  'keeps newer saved version held for %s historical receipt',
  (kind) => {
    const item = linkedInFixture();
    item.recovery.approvalCommandId = commandId;
    item.recovery.attempts = [
      {
        commandId,
        receipt:
          kind === 'unknown'
            ? null
            : receipt(
                kind === 'pending' ? 'pending' : 'rejected',
                kind === 'mismatched' ? 'different-command' : commandId,
              ),
      },
    ];
    const s = linkedInSession({} as LinkedInApi, 'ws', item);
    s.ingest({
      ...item,
      draft: { ...item.draft, revision: 2, body: 'New' },
      recovery: { ...item.recovery, revision: 2 },
    });
    expect(s.canUseSavedVersion()).toBe(false);
    s.useSavedVersion();
    expect(s.snapshot().body).toBe(item.draft.body);
  },
);
it.each([
  ['pending', 'applied'],
  ['pending', 'rejected'],
  ['unknown', 'applied'],
  ['unknown', 'rejected'],
] as const)(
  'exact %s historical report retry to %s bypasses only draft conflict',
  async (initial, terminal) => {
    const item = linkedInFixture();
    item.recovery = {
      ...item.recovery,
      started: true,
      handoffId: 'handoff',
      approvalCommandId: commandId,
      attempts: [{ commandId, receipt: receipt('applied') }],
    };
    const api = {
      reportOutcome: vi.fn(
        async (input: Parameters<LinkedInApi['reportOutcome']>[0]) => {
          if (initial === 'unknown') throw Error('unknown');
          return {
            draftId: item.draft.id,
            revision: 1,
            receipt: receipt('pending', input.commandId),
          };
        },
      ),
      recover: vi.fn(async () => item.recovery),
      begin: vi.fn(),
      copy: vi.fn(),
      open: vi.fn(),
    } as unknown as LinkedInApi;
    const s = linkedInSession(api, 'ws', item);
    await s.report('not_sent', '');
    const retained = vi.mocked(api.reportOutcome).mock.calls[0]![0];
    s.ingest({
      ...item,
      draft: { ...item.draft, revision: 2, body: 'New' },
      recovery: {
        ...item.recovery,
        revision: 2,
        approvalCommandId: null,
        attempts: [],
        started: false,
        handoffId: null,
      },
    });
    await s.recover();
    s.setActionHold('Authority unavailable');
    await s.retryReport();
    expect(api.reportOutcome).toHaveBeenCalledTimes(1);
    s.setActionHold(undefined);
    setDailySessionScope(api, null);
    await s.retryReport();
    expect(api.reportOutcome).toHaveBeenCalledTimes(1);
    setDailySessionScope(api, 'ws');
    await s.begin();
    await s.helper('copy');
    await s.helper('open');
    await s.report('reply', 'Different report');
    expect(api.begin).not.toHaveBeenCalled();
    expect(api.copy).not.toHaveBeenCalled();
    expect(api.open).not.toHaveBeenCalled();
    expect(api.reportOutcome).toHaveBeenCalledTimes(1);
    expect(s.canUseSavedVersion()).toBe(false);
    vi.mocked(api.reportOutcome).mockResolvedValueOnce({
      draftId: item.draft.id,
      revision: 1,
      receipt: receipt(terminal, retained.commandId),
    });
    await s.retryReport();
    expect(api.reportOutcome).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.reportOutcome).mock.calls[1]![0]).toEqual(retained);
    expect(s.snapshot().conflict).toBe(true);
    expect(s.snapshot().body).toBe(item.draft.body);
    expect(s.canUseSavedVersion()).toBe(true);
    s.useSavedVersion();
    expect(s.snapshot().body).toBe('New');
  },
);
