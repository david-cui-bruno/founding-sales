import { z } from 'zod';
import {
  dashboardResponseSchema,
  diagnosticsResponseSchema,
  pipelineStageDtoSchema,
  settingsSnapshotSchema,
  type SettingKey,
} from '@fss/contracts';
import type {
  AdminScreen,
  AdminState,
  PipelineStageRowView,
  SaveSettingInput,
} from '../renderer/settingsContract.ts';
import type { AuthedClient } from './authedClient.ts';

/**
 * The administration window's half of the bridge, in the main process
 * (specification 10.1, 13.3, 13.4, 14.2).
 *
 * The same shape as G6's Today and CRM bridges, and for the same reasons: the
 * renderer is handed a state and never a token, every mutation goes through
 * `command` so the 5.3 envelope cannot be forgotten, and a refusal arrives as a
 * stable code the view turns into one sentence.
 *
 * It computes nothing. `effectiveSendingEnabled` is read out of the settings
 * response rather than recomputed, the dashboard's audience is whatever the server
 * decided, and a stage's administrability is the terminal flag the server sent. A
 * client that recomputed any of those would be a second implementation of a rule
 * that has to have exactly one.
 */

export const ADMIN_IPC_CHANNELS = {
  state: 'callie:admin:state',
  show: 'callie:admin:show',
  saveSetting: 'callie:admin:save-setting',
  openHistory: 'callie:admin:open-history',
  loadDashboard: 'callie:admin:load-dashboard',
  createStage: 'callie:admin:create-stage',
  renameStage: 'callie:admin:rename-stage',
  reorderStages: 'callie:admin:reorder-stages',
  retireStage: 'callie:admin:retire-stage',
  acknowledgeAlert: 'callie:admin:acknowledge-alert',
} as const;
export type AdminIpcChannel = (typeof ADMIN_IPC_CHANNELS)[keyof typeof ADMIN_IPC_CHANNELS];

const stagesSchema = z.object({ stages: z.array(pipelineStageDtoSchema) });
const historySchema = z.object({
  settingKey: z.string(),
  versions: z.array(
    z.object({
      version: z.number(),
      changeNote: z.string().nullable(),
      changedAt: z.string(),
      supersededAt: z.string().nullable(),
    }),
  ),
});
const acknowledgedSchema = z.object({ acknowledged: z.literal(true), alertKey: z.string() });

export interface AdminBridgeDeps {
  readonly api: AuthedClient;
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly device: { readonly role: 'admin' | 'salesperson' } | null;
    }>;
  };
  /** The default dashboard window, so the page has something to show on open. */
  readonly now?: () => Date;
}

export interface AdminBridgeHost {
  state(): Promise<AdminState>;
  show(input: { readonly screen: AdminScreen }): Promise<AdminState>;
  saveSetting(input: SaveSettingInput): Promise<AdminState>;
  openHistory(input: { readonly settingKey: SettingKey }): Promise<AdminState>;
  loadDashboard(input: { readonly from: string; readonly to: string }): Promise<AdminState>;
  createStage(input: { readonly key: string; readonly displayName: string }): Promise<AdminState>;
  renameStage(input: { readonly stageKey: string; readonly displayName: string }): Promise<AdminState>;
  reorderStages(input: { readonly stageKeys: readonly string[] }): Promise<AdminState>;
  retireStage(input: { readonly stageKey: string }): Promise<AdminState>;
  acknowledgeAlert(input: { readonly alertId: string }): Promise<AdminState>;
}

/** The last 30 days, in UTC. A window the page shows and a person may change. */
function defaultWindow(now: Date): { readonly from: string; readonly to: string } {
  const to = new Date(now.getTime());
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export function createAdminBridge(deps: AdminBridgeDeps): AdminBridgeHost {
  const clock = deps.now ?? ((): Date => new Date());
  let screen: AdminScreen = 'settings';
  let notice: string | null = null;
  let settings: AdminState['settings'] = null;
  let dashboard: AdminState['dashboard'] = null;
  let diagnostics: AdminState['diagnostics'] = null;
  let stages: readonly PipelineStageRowView[] = [];
  let history: AdminState['history'] = null;
  let window = defaultWindow(clock());

  const snapshot = async (): Promise<AdminState> => {
    const session = await deps.session.state();
    return {
      screen,
      role: session.device?.role ?? 'salesperson',
      online: session.online,
      mayMutate: session.mayMutate,
      notice,
      settings,
      dashboard,
      diagnostics,
      stages,
      history,
    };
  };

  const loadSettings = async (): Promise<void> => {
    const answer = await deps.api.read('/settings', value => settingsSnapshotSchema.parse(value));
    if (!answer.ok) {
      notice = answer.reason;
      return;
    }
    settings = answer.value;
    const stageAnswer = await deps.api.read('/pipeline/stages', value => stagesSchema.parse(value));
    if (stageAnswer.ok) {
      stages = stageAnswer.value.stages.map(stage => ({
        key: stage.key,
        displayName: stage.displayName,
        position: stage.position,
        terminalKind: stage.terminalKind,
        retired: stage.retired,
      }));
    }
  };

  const loadDashboardFor = async (next: { readonly from: string; readonly to: string }): Promise<void> => {
    window = next;
    const answer = await deps.api.read('/dashboard', value => dashboardResponseSchema.parse(value), {
      window: next,
    });
    if (!answer.ok) {
      notice = answer.reason;
      return;
    }
    dashboard = answer.value;
  };

  const loadDiagnostics = async (): Promise<void> => {
    const answer = await deps.api.read('/diagnostics', value => diagnosticsResponseSchema.parse(value));
    if (!answer.ok) {
      notice = answer.reason;
      return;
    }
    diagnostics = answer.value;
  };

  /** Run a command, then re-read the slice it changed. Never patch local state. */
  const afterCommand = async (
    outcome: { readonly ok: boolean; readonly reason?: string },
    reload: () => Promise<void>,
  ): Promise<AdminState> => {
    if (!outcome.ok) {
      notice = outcome.reason ?? 'refused';
      return await snapshot();
    }
    notice = null;
    await reload();
    return await snapshot();
  };

  return {
    async state() {
      if (settings === null) await loadSettings();
      return await snapshot();
    },

    async show(input) {
      notice = null;
      screen = input.screen;
      if (input.screen === 'settings') await loadSettings();
      if (input.screen === 'dashboard') await loadDashboardFor(window);
      if (input.screen === 'diagnostics') await loadDiagnostics();
      return await snapshot();
    },

    async saveSetting(input) {
      const outcome = await deps.api.command(
        '/settings/update',
        { settingKey: input.settingKey, value: input.value, changeNote: input.changeNote },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async openHistory(input) {
      const answer = await deps.api.read('/settings/history', value => historySchema.parse(value), {
        settingKey: input.settingKey,
      });
      if (!answer.ok) {
        notice = answer.reason;
        return await snapshot();
      }
      history = { settingKey: input.settingKey, versions: answer.value.versions };
      return await snapshot();
    },

    async loadDashboard(input) {
      notice = null;
      screen = 'dashboard';
      await loadDashboardFor(input);
      return await snapshot();
    },

    async createStage(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/create',
        { key: input.key, displayName: input.displayName },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async renameStage(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/rename',
        { stageKey: input.stageKey, displayName: input.displayName },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async reorderStages(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/reorder',
        { stageKeys: [...input.stageKeys] },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async retireStage(input) {
      const outcome = await deps.api.command(
        '/pipeline/stages/retire',
        { stageKey: input.stageKey },
        value => value,
      );
      return await afterCommand(outcome, loadSettings);
    },

    async acknowledgeAlert(input) {
      // G5's acknowledge is not a receipted command: it is admin-only, audited, and
      // answers `{ acknowledged: true, alertKey }`. Calling it through `command`
      // would add a command id the endpoint does not read.
      const answer = await deps.api.read('/admin/alerts/acknowledge', value => acknowledgedSchema.parse(value), {
        alertId: input.alertId,
      });
      return await afterCommand(
        answer.ok ? { ok: true } : { ok: false, reason: answer.reason },
        loadDiagnostics,
      );
    },
  };
}
