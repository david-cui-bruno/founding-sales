import { useEffect, useMemo, useRef } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import type { Generation } from '../app/generation.ts';
import { useViewState, type ViewState } from '../app/useViewState.ts';
import type {
  ActiveSettingKey,
  AddCallingNumberInput,
  AdminScreen,
  AdminState,
  AllowStatesInput,
  RecordHolidayCalendarInput,
  RecordSendingAuthenticationInput,
  SaveSettingInput,
  SetSendingCapInput,
} from '../settingsContract.ts';
import type { SettingsTab } from '../routes.ts';

/**
 * Settings' reads and commands, and the tab they are about (1.0.13).
 *
 * The three tabs are three screens of one bridge — it holds the settings, the figures and
 * the report, and re-reads the slice a command changed rather than patching its own copy
 * — so switching a tab is a read, and the view is the same `useViewState` the other two
 * views use.
 *
 * The shell's word for a tab is `administration`; this bridge has called that screen
 * `settings` since it was a window of its own. The two names are translated here, in one
 * pair of functions, so neither side has to learn the other's.
 */

export function screenForTab(tab: SettingsTab): AdminScreen {
  return tab === 'administration' ? 'settings' : tab;
}

export function tabForScreen(screen: AdminScreen): SettingsTab {
  return screen === 'settings' ? 'administration' : screen;
}

export interface AdminActions {
  /** Read this tab again, which is what Retry means everywhere on this page. */
  show(tab: SettingsTab): void;
  saveSetting(input: SaveSettingInput): void;
  openHistory(settingKey: ActiveSettingKey): void;
  retireStage(stageKey: string): void;
  acknowledgeAlert(alertId: string): void;
  setSendingCap(input: SetSendingCapInput): void;
  recordSendingAuthentication(input: RecordSendingAuthenticationInput): void;
  recordHolidayCalendar(input: RecordHolidayCalendarInput): void;
  addCallingNumber(input: AddCallingNumberInput): void;
  retireCallingNumber(identityId: string): void;
  allowStates(input: AllowStatesInput): void;
  revokePosture(postureId: string): void;
}

export interface Admin extends ViewState<AdminState> {
  readonly actions: AdminActions;
}

export function useAdmin(tab: SettingsTab, identity: string | null, generation: number, guard: Generation): Admin {
  const first = useMemo(
    () =>
      async (api: OperationApi): Promise<AdminState> => await api.read('settings.show', { screen: screenForTab(tab) }),
    // The first read of a mount is the tab it was mounted on; a later tab is the effect
    // below, which is a read rather than a fresh mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const view = useViewState<AdminState>({ key: 'settings', identity, generation, guard, first });
  const { read, command, state } = view;

  const actions = useMemo<AdminActions>(
    () => ({
      show: next => {
        read(api => api.read('settings.show', { screen: screenForTab(next) }));
      },
      saveSetting: input => {
        command(api => api.command('settings.saveSetting', input));
      },
      openHistory: settingKey => {
        read(api => api.read('settings.openHistory', { settingKey }));
      },
      retireStage: stageKey => {
        command(api => api.command('settings.retireStage', { stageKey }));
      },
      acknowledgeAlert: alertId => {
        command(api => api.command('settings.acknowledgeAlert', { alertId }));
      },
      setSendingCap: input => {
        command(api => api.command('settings.setSendingCap', input));
      },
      recordSendingAuthentication: input => {
        command(api => api.command('settings.recordSendingAuthentication', input));
      },
      recordHolidayCalendar: input => {
        command(api => api.command('settings.recordHolidayCalendar', input));
      },
      addCallingNumber: input => {
        command(api => api.command('settings.addCallingNumber', input));
      },
      retireCallingNumber: identityId => {
        command(api => api.command('settings.retireCallingNumber', { identityId }));
      },
      allowStates: input => {
        command(api => api.command('settings.allowStates', input));
      },
      revokePosture: postureId => {
        command(api => api.command('settings.revokePosture', { postureId }));
      },
    }),
    [read, command],
  );

  // The tab the person asked for is the screen the bridge should be on. A tab pressed
  // twice does not read twice; a tab the bridge is already showing does not read at all.
  const asked = useRef<SettingsTab | null>(null);
  const { show } = actions;
  useEffect(() => {
    if (state === null) return;
    if (tabForScreen(state.screen) === tab || asked.current === tab) return;
    asked.current = tab;
    show(tab);
  }, [tab, state, show]);

  return useMemo(() => ({ ...view, actions }), [view, actions]);
}
