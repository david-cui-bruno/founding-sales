// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PresentationRoot } from '../../app/PresentationRoot';
import { NativeDeskRoute, type NativeDeskApi } from './NativeDeskRoute';
import { configuredFixtureStatus, dailyFixture, localSnapshot, nativeDeskFixture } from './nativeDesk.fixture';
import { captureDailySessionScope } from './dailySessionScope';
import type { DailySnapshot } from '../../../shared/contracts/dailyContract';

afterEach(cleanup);
type Config = Awaited<ReturnType<NativeDeskApi['delegation']['status']>>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ownedDaily(workspaceId = 'ws') {
  const snapshot = dailyFixture({ workspaceId });
  snapshot.ownerStatus = snapshot.accounts.map(({ account }): DailySnapshot['ownerStatus'][number] => ({
    accountId: account.id,
    authority: { accountId: account.id, owner: 'worker', generation: 1, state: 'active' },
    executionVersion: 1, pendingCommands: [], status: 'owner_applied',
  }));
  return snapshot;
}
function fixture() {
  const f = nativeDeskFixture(ownedDaily());
  const daily = deferred<DailySnapshot>();
  const config = deferred<Config>();
  const dailyGet = vi.spyOn(f.api.daily, 'get').mockReturnValue(daily.promise);
  const status = vi.spyOn(f.api.delegation, 'status').mockReturnValue(config.promise);
  const element = () => <NativeDeskRoute api={f.api} firstUse={f.firstUse} />;
  return { ...f, daily, config, dailyGet, status, element };
}
function mount(f: ReturnType<typeof fixture>) {
  return render(f.element(), { wrapper: PresentationRoot });
}
async function settle(action: () => void) {
  await act(async () => { action(); });
}
function openEditor() {
  fireEvent.click(screen.getByRole('button', { name: 'Email · Account A' }));
  return screen.getByLabelText('Email body') as HTMLTextAreaElement;
}
function preflight() {
  return screen.getByRole('button', { name: 'Owner preflight', hidden: true }) as HTMLButtonElement;
}
function expectHeld(api: NativeDeskApi, workspaceId = 'ws') {
  expect(() => captureDailySessionScope(api.delegation, workspaceId)).toThrow();
}
function expectNoCommands(f: ReturnType<typeof fixture>) {
  expect(f.calls.filter(call => !['daily.get', 'delegation.status', 'localWorkspace.get', 'localWorkspace.getCommitments'].includes(call.method))).toEqual([]);
}

describe('daily publication independent of local configuration', () => {
  it('publishes validated saved daily content while configuration never settles, with actions held', async () => {
    const f = fixture(); mount(f);
    await settle(() => f.daily.resolve(ownedDaily()));
    expect(screen.queryByText('Loading daily workspace…')).toBeNull();
    const editor = openEditor();
    expect(editor.value).toBe('Saved note for a');
    expect(preflight().disabled).toBe(true);
    expectHeld(f.api);
    expectNoCommands(f);
  });

  it('configuration first cannot establish workflow mode or publish content', async () => {
    const f = fixture();
    f.setLocalSnapshot(localSnapshot({ workflowMode: 'legacy' }));
    mount(f);
    await settle(() => f.config.resolve(configuredFixtureStatus()));
    expect(screen.getByText('Loading daily workspace…')).toBeTruthy();
    expect(screen.queryByText(/Legacy workflow is active/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Email · Account A' })).toBeNull();
    expectHeld(f.api);
    await settle(() => f.daily.resolve(dailyFixture({ workflowMode: 'legacy' })));
    expect(screen.getByText(/Legacy workflow is active/)).toBeTruthy();
    expect(screen.queryByTestId('native-desk')).toBeNull();
    expectHeld(f.api);
  });

  it.each(['matching', 'foreign', 'paused', 'missing-owner'] as const)('late %s config only admits the validated owner scope', async kind => {
    const f = fixture(); mount(f);
    await settle(() => f.daily.resolve(kind === 'missing-owner' ? dailyFixture() : ownedDaily()));
    const editor = openEditor();
    expect(preflight().disabled).toBe(true);
    const config = configuredFixtureStatus();
    await settle(() => f.config.resolve({ ...config,
      workspaceId: kind === 'foreign' ? 'foreign' : 'ws',
      state: kind === 'paused' ? 'paused' : 'active',
    }));
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(preflight().disabled).toBe(kind !== 'matching');
    if (kind === 'foreign' || kind === 'paused') expectHeld(f.api);
    else expect(() => captureDailySessionScope(f.api.delegation, 'ws')).not.toThrow();
    expectNoCommands(f);
  });

  it('failed configuration leaves saved content visible and held', async () => {
    const f = fixture(); mount(f);
    await settle(() => f.daily.resolve(ownedDaily()));
    const editor = openEditor();
    await settle(() => f.config.reject(Error('unavailable')));
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(preflight().disabled).toBe(true);
    expectHeld(f.api);
    expectNoCommands(f);
  });

  it.each(['reject', 'invalid'] as const)('failed daily refresh (%s) retains editor and cannot be revived by late config', async failure => {
    const f = fixture(); mount(f);
    await settle(() => { f.daily.resolve(ownedDaily()); f.config.resolve(configuredFixtureStatus()); });
    const editor = openEditor();
    editor.focus();
    fireEvent.change(editor, { target: { value: 'Retained local edit' } });
    editor.setSelectionRange(3, 3);
    const previousScope = captureDailySessionScope(f.api.delegation, 'ws');
    const daily = deferred<DailySnapshot>(), config = deferred<Config>();
    f.dailyGet.mockReturnValue(daily.promise); f.status.mockReturnValue(config.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expectHeld(f.api);
    expect(previousScope).toThrow();
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(preflight().disabled).toBe(true);
    await settle(() => failure === 'reject' ? daily.reject(Error('offline')) : daily.resolve({} as DailySnapshot));
    expect(screen.getByText(/Refresh unavailable. Your current view/)).toBeTruthy();
    await settle(() => config.resolve(configuredFixtureStatus()));
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(editor.value).toBe('Retained local edit');
    expect(editor.selectionStart).toBe(3);
    expect(document.activeElement).toBe(editor);
    expect(preflight().disabled).toBe(true);
    expectHeld(f.api);
    expectNoCommands(f);
  });

  it('overlapping refresh cannot apply earlier configuration to a later validated snapshot', async () => {
    const f = fixture(); mount(f);
    await settle(() => f.daily.resolve(ownedDaily()));
    openEditor();
    const nextDaily = deferred<DailySnapshot>(), nextConfig = deferred<Config>();
    f.dailyGet.mockReturnValue(nextDaily.promise); f.status.mockReturnValue(nextConfig.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await settle(() => nextDaily.resolve(ownedDaily()));
    await settle(() => f.config.resolve(configuredFixtureStatus()));
    expect(preflight().disabled).toBe(true);
    expectHeld(f.api);
    await settle(() => nextConfig.resolve(configuredFixtureStatus()));
    expect(preflight().disabled).toBe(false);
    expectNoCommands(f);
  });

  it('config-first refresh cannot admit retained content before its own daily validation', async () => {
    const f = fixture(); mount(f);
    await settle(() => { f.daily.resolve(ownedDaily()); f.config.resolve(configuredFixtureStatus()); });
    const editor = openEditor();
    const nextDaily = deferred<DailySnapshot>(), nextConfig = deferred<Config>();
    f.dailyGet.mockReturnValue(nextDaily.promise); f.status.mockReturnValue(nextConfig.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await settle(() => nextConfig.resolve(configuredFixtureStatus()));
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(preflight().disabled).toBe(true);
    expectHeld(f.api);
    await settle(() => nextDaily.resolve(ownedDaily()));
    expect(screen.getByLabelText('Email body')).toBe(editor);
    expect(preflight().disabled).toBe(false);
    expectNoCommands(f);
  });

  it('late daily and config from superseded reads cannot replace the current workspace', async () => {
    const f = fixture(); mount(f);
    await settle(() => undefined);
    const nextDaily = deferred<DailySnapshot>(), nextConfig = deferred<Config>();
    f.dailyGet.mockReturnValue(nextDaily.promise); f.status.mockReturnValue(nextConfig.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await settle(() => { nextDaily.resolve(ownedDaily('new')); nextConfig.resolve({ ...configuredFixtureStatus(), workspaceId: 'new' }); });
    const guard = captureDailySessionScope(f.api.delegation, 'new');
    await settle(() => { f.daily.resolve(ownedDaily()); f.config.resolve(configuredFixtureStatus()); });
    expect(guard).not.toThrow();
    expectHeld(f.api, 'ws');
    openEditor(); expect(preflight().disabled).toBe(false);
    expectNoCommands(f);
  });

  it.each(['daily', 'config'] as const)('API replacement rejects late %s completions without crossing owners', async pending => {
    const old = fixture(), next = fixture();
    const view = mount(old);
    if (pending === 'config') {
      await settle(() => old.daily.resolve(ownedDaily()));
      openEditor();
    } else await settle(() => old.config.resolve(configuredFixtureStatus()));
    view.rerender(next.element());
    expectHeld(old.api);
    expect(screen.queryByLabelText('Email body')).toBeNull();
    await settle(() => { old.daily.resolve(ownedDaily()); old.config.resolve(configuredFixtureStatus()); });
    expect(screen.getByText('Loading daily workspace…')).toBeTruthy();
    await settle(() => next.daily.resolve(ownedDaily('new')));
    openEditor(); expect(preflight().disabled).toBe(true);
    await settle(() => next.config.resolve({ ...configuredFixtureStatus(), workspaceId: 'new' }));
    expect(preflight().disabled).toBe(false);
    expectHeld(old.api);
    expect(() => captureDailySessionScope(next.api.delegation, 'new')).not.toThrow();
    expectNoCommands(old); expectNoCommands(next);
  });

  it.each(['daily', 'config'] as const)('unmount fences late %s completion, including same-API remount', async pending => {
    const f = fixture(); const view = mount(f);
    if (pending === 'config') await settle(() => f.daily.resolve(ownedDaily()));
    else await settle(() => f.config.resolve(configuredFixtureStatus()));
    view.unmount();
    const nextDaily = deferred<DailySnapshot>(), nextConfig = deferred<Config>();
    f.dailyGet.mockReturnValue(nextDaily.promise); f.status.mockReturnValue(nextConfig.promise);
    mount(f);
    await settle(() => { f.daily.resolve(ownedDaily()); f.config.resolve(configuredFixtureStatus()); });
    expect(screen.getByText('Loading daily workspace…')).toBeTruthy();
    expectHeld(f.api);
    await settle(() => nextDaily.resolve(ownedDaily()));
    openEditor(); expect(preflight().disabled).toBe(true);
    expectHeld(f.api);
    expectNoCommands(f);
  });
});
