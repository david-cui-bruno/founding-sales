import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import type { Generation } from '../app/generation.ts';
import { useClearDrafts } from '../app/drafts.tsx';
import { useViewState, type ViewState } from '../app/useViewState.ts';
import type {
  ActiveSettingKey,
  AddCallingNumberInput,
  AdminScreen,
  AdminState,
  AllowStatesInput,
  RecordHolidayCalendarInput,
  RecordSendingAuthenticationInput,
  SaveIntegrationInput,
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
  saveIntegration(input: SaveIntegrationInput): void;
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
  /** The form whose command was sent last, or null after a read: whose notice the page's is. */
  readonly lastForm: string | null;
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
  const { read: viewRead, command: viewCommand, state } = view;
  // Which form spoke last (S4R): the answer's one notice belongs beside that form's control.
  const [lastForm, setLastForm] = useState<string | null>(null);
  const read = useCallback<typeof view.read>(
    next => {
      setLastForm(null);
      viewRead(next);
    },
    [viewRead],
  );
  const clearDrafts = useClearDrafts();
  const command = useCallback<typeof view.command>(
    (form, next) => {
      setLastForm(form);
      viewCommand(form, async api => {
        const answer = await next(api);
        // A posture confirmation is spent the moment the server records or already holds the
        // states it was given for (K6): cleared by the command's own answer, here, so it is gone
        // whether or not the form is still mounted, and never carried to the next state chosen.
        if (form === 'postures' && (answer.notice === 'posture_recorded' || answer.notice === 'posture_already_allowed')) {
          clearDrafts('settings:postures:');
        }
        return answer;
      });
    },
    [viewCommand, clearDrafts],
  );

  const actions = useMemo<AdminActions>(
    () => ({
      show: next => {
        read(api => api.read('settings.show', { screen: screenForTab(next) }));
      },
      saveSetting: input => {
        command(`setting:${input.settingKey}`, api => api.command('settings.saveSetting', input));
      },
      saveIntegration: input => {
        command(`integration:${input.settingKey}`, api => api.command('settings.saveIntegration', input));
      },
      openHistory: settingKey => {
        read(api => api.read('settings.openHistory', { settingKey }));
      },
      retireStage: stageKey => {
        command(`stage:${stageKey}`, api => api.command('settings.retireStage', { stageKey }));
      },
      acknowledgeAlert: alertId => {
        command(`alert:${alertId}`, api => api.command('settings.acknowledgeAlert', { alertId }));
      },
      setSendingCap: input => {
        command('sending-cap', api => api.command('settings.setSendingCap', input));
      },
      recordSendingAuthentication: input => {
        command('sending-domain', api => api.command('settings.recordSendingAuthentication', input));
      },
      recordHolidayCalendar: input => {
        command('holidays', api => api.command('settings.recordHolidayCalendar', input));
      },
      addCallingNumber: input => {
        command('calling-number', api => api.command('settings.addCallingNumber', input));
      },
      retireCallingNumber: identityId => {
        command(`calling-number:${identityId}`, api => api.command('settings.retireCallingNumber', { identityId }));
      },
      allowStates: input => {
        command('postures', api => api.command('settings.allowStates', input));
      },
      revokePosture: postureId => {
        command(`posture:${postureId}`, api => api.command('settings.revokePosture', { postureId }));
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

  return useMemo(() => ({ ...view, actions, lastForm }), [view, actions, lastForm]);
}
