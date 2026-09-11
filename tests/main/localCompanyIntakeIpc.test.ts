import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalWorkspaceApi } from '../../src/shared/contracts/localWorkspaceContract';
import type { LocalCompanyCreateRequest, LocalCompanyInput, LocalCompanyReview } from '../../src/shared/contracts/localCompanyIntakeContract';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createLocalWorkspaceApi } from '../../src/preload/apis/localWorkspaceApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const input: LocalCompanyInput = { name: 'Example PM', domain: null };
const command = { ...input, commandId: '11111111-1111-4111-8111-111111111111' };
const account = { ...input, id: 'account', version: 1 };
const trusted = { senderFrame: { url: 'callie://app/index.html' } };
const review = (value: LocalCompanyInput): LocalCompanyReview => ({ scope: 'local_database', input: value, candidates: [], complete: true });
const provider = () => ({
  get: async () => { throw new Error('unused'); }, getCompany: async () => { throw new Error('unused'); }, researchCompany: async () => { throw new Error('unused'); }, getCompanyResearchStatus: async () => { throw new Error('unused'); }, getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: async () => { throw new Error('unused'); }, getCommitments: async () => { throw new Error('unused'); }, transition: async () => { throw new Error('unused'); },
  reviewCompany: async (value: LocalCompanyInput) => review(value),
  createCompany: async (value: LocalCompanyCreateRequest) => ({ status: 'saved' as const, commandId: value.commandId, account, replayed: false }),
  getCompanyCreateStatus: async (value: LocalCompanyCreateRequest) => ({ status: 'saved' as const, commandId: value.commandId, account }),
});
beforeEach(() => vi.clearAllMocks());
describe('local company public bridge', () => {
  it('roundtrips strict canonical requests and rejects sender, arity, and bypass flags', async () => {
    const dispose = registerLocalWorkspaceIpc(provider());
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
    expect(await api.reviewCompany({ ...input, name: ' Example PM ' })).toEqual(review(input));
    expect(await api.createCompany(command)).toEqual({ status: 'saved', commandId: command.commandId, account, replayed: false });
    expect(await api.getCompanyCreateStatus(command)).toEqual({ status: 'saved', commandId: command.commandId, account });
    for (const [channel, value] of [['local-workspace:review-company', input], ['local-workspace:create-company', command], ['local-workspace:company-create-status', command]] as const) {
      const handler = registeredIpcHandler(electron.handle, channel);
      for (const args of [[], [value, value], [{ ...value, createAnyway: true }]]) await expect(handler(trusted, ...args)).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://evil.invalid' } }, value)).rejects.toThrow();
    }
    dispose();
  });
  it('rejects valid-shaped but wrong echoed identity or command at both boundaries', async () => {
    const wrongCommand = '22222222-2222-4222-8222-222222222222';
    const cases = [
      { method: 'reviewCompany' as const, channel: 'local-workspace:review-company', value: input, response: review({ ...input, name: 'Wrong' }) },
      { method: 'createCompany' as const, channel: 'local-workspace:create-company', value: command, response: { status: 'saved', commandId: wrongCommand, account, replayed: false } },
      { method: 'createCompany' as const, channel: 'local-workspace:create-company', value: command, response: { status: 'saved', commandId: command.commandId, account: { ...account, domain: 'wrong.invalid' }, replayed: false } },
      { method: 'createCompany' as const, channel: 'local-workspace:create-company', value: command, response: { status: 'needs_review', commandId: command.commandId, review: review({ ...input, name: 'Wrong' }) } },
      { method: 'getCompanyCreateStatus' as const, channel: 'local-workspace:company-create-status', value: command, response: { status: 'not_recorded', commandId: wrongCommand } },
      { method: 'getCompanyCreateStatus' as const, channel: 'local-workspace:company-create-status', value: command, response: { status: 'saved', commandId: command.commandId, account: { ...account, version: 2 } } },
    ];
    for (const test of cases) {
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => test.response }));
      if (test.method === 'reviewCompany') await expect(api.reviewCompany(input)).rejects.toThrow();
      else await expect(api[test.method](command)).rejects.toThrow();
      const invalid = { ...provider(), [test.method]: async () => test.response } as unknown as LocalWorkspaceApi;
      const dispose = registerLocalWorkspaceIpc(invalid);
      await expect(registeredIpcHandler(electron.handle, test.channel)(trusted, test.value)).rejects.toThrow(/^LOCAL_COMPANY_(REVIEW|CREATE|CREATE_STATUS)_FAILED$/);
      dispose(); vi.clearAllMocks();
    }
  });
  it('never converts unavailable provider or malformed response into not_recorded, saved or empty success', async () => {
    const fail = async (): Promise<never> => { throw new Error('/private/database/sqlite secret'); };
    const dispose = registerLocalWorkspaceIpc({ ...provider(), reviewCompany: fail, createCompany: fail, getCompanyCreateStatus: fail });
    for (const [channel, error, value] of [
      ['local-workspace:review-company', 'LOCAL_COMPANY_REVIEW_FAILED', input],
      ['local-workspace:create-company', 'LOCAL_COMPANY_CREATE_FAILED', command],
      ['local-workspace:company-create-status', 'LOCAL_COMPANY_CREATE_STATUS_FAILED', command],
    ] as const) await expect(registeredIpcHandler(electron.handle, channel)(trusted, value)).rejects.toThrow(new RegExp(`^${error}$`));
    dispose();
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => ({ status: 'unknown' }) }));
    await expect(api.createCompany(command)).rejects.toThrow();
    await expect(api.getCompanyCreateStatus(command)).rejects.toThrow();
    await expect(api.reviewCompany(input)).rejects.toThrow();
  });
});
