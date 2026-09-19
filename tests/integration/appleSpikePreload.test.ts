import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: {
    invoke: electron.invoke,
    on: electron.on,
    removeListener: electron.removeListener,
  },
}));

import type { CalliePreloadApi } from '../../src/shared/preload';

/**
 * The exact preload namespace inventory. This file keeps its historical name because the gitleaks
 * allowlist pins its path byte-for-byte; the Apple feasibility spike it once covered was removed on
 * 18 September 2026 and nothing Apple-specific remains on the bridge.
 */
describe('preload namespace inventory', () => {
  beforeEach(async () => {
    electron.exposeInMainWorld.mockReset();
    electron.invoke.mockReset();
    electron.on.mockReset();
    electron.removeListener.mockReset();
    vi.resetModules();
    await import('../../src/preload');
  });

  function exposedApi(): CalliePreloadApi {
    const exposure = electron.exposeInMainWorld.mock.calls[0] as
      | [string, CalliePreloadApi]
      | undefined;
    if (exposure === undefined) throw new Error('callie preload API was not exposed');
    expect(exposure[0]).toBe('callie');
    return exposure[1];
  }

  it('exposes only the enumerated namespaces and methods with no raw dispatcher', () => {
    const api = exposedApi();

    expect(Object.keys(api).sort()).toEqual([
      'daily', 'delegation', 'health', 'leadDetail', 'leads', 'linkedin', 'localWorkspace', 'outreach', 'phoneSetup', 'recovery', 'shell',
      // `templates` stays on its own line so the line above keeps the exact bytes the gitleaks allowlist pins.
      'templates',
    ]);
    expect(Object.keys(api.leads)).toEqual(['list']);
    expect(Object.keys(api.leadDetail)).toEqual(['get']);
    expect(Object.keys(api.daily)).toEqual(['get']);
    expect(api.daily.get).toBeTypeOf('function');
    expect(Object.keys(api.delegation).sort()).toEqual([
      'admitReplyFirstDraft', 'approveReply', 'approveRequestedFollowup', 'beginPhone', 'bootstrap', 'closeCallback', 'configure', 'configureIntake', 'configurePolicy', 'configureResearch',
      'editReplyDraft', 'editRequestedFollowup', 'getAccountPreparation', 'getPhoneHandoffState', 'getRequestedFollowup', 'getSelectedAccountFreshness', 'googleConnections', 'listCallbacks', 'neverCall', 'pair', 'pairing', 'policyImport', 'prepareRequestedFollowup', 'readSuppression', 'reconcileReplyDraft', 'refreshSelectedAccount', 'researchSetup', 'rotatePairing', 'saveCallback', 'status', 'submit', 'submitApprovedReply', 'sync', 'territoryPolicy',
    ]);
    expect(Object.keys(api.linkedin).sort()).toEqual([
      'begin', 'copy', 'get', 'open', 'prepare', 'recover', 'reportOutcome', 'save',
    ]);
    expect(Object.keys(api.delegation.policyImport).sort()).toEqual(['confirm', 'resume', 'selectAndPreview', 'status']);
    const { policyImport, googleConnections, researchSetup, ...delegationMethods } = api.delegation;
    if (!googleConnections) throw new Error('Current preload must expose Google connections');
    expect(Object.keys(googleConnections).sort()).toEqual(['begin', 'disclosure', 'revoke', 'status']);
    if (!researchSetup) throw new Error('Current preload must expose research setup');
    expect(Object.keys(researchSetup).sort()).toEqual(['approve', 'cancelPending', 'retry', 'setState', 'status']);
    for (const namespace of [delegationMethods, api.linkedin, policyImport, googleConnections, researchSetup]) {
      for (const method of Object.values(namespace)) expect(method).toBeTypeOf('function');
    }
    for (const namespace of [api.delegation, api.linkedin, policyImport, googleConnections, researchSetup]) {
      expect(namespace).not.toHaveProperty('invoke');
      expect(namespace).not.toHaveProperty('run');
      expect(namespace).not.toHaveProperty('dispatch');
    }
    expect(Object.keys(api.phoneSetup).sort()).toEqual(['clear', 'confirm', 'status']);
    for (const method of ['status', 'confirm', 'clear'] as const) expect(api.phoneSetup[method]).toBeTypeOf('function');
    expect(api.phoneSetup).not.toHaveProperty('invoke');
    expect(api.phoneSetup).not.toHaveProperty('run');
    expect(electron.invoke).not.toHaveBeenCalled();
  });
});
