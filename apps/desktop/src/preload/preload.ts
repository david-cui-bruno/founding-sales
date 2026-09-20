import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.ts';
import { CRM_IPC_CHANNELS } from '../main/crmBridge.ts';
import { TODAY_IPC_CHANNELS } from '../main/todayBridge.ts';
import { ADMIN_IPC_CHANNELS } from '../main/settingsBridge.ts';
import { desktopStateSchema, type DesktopBridge, type DesktopState } from '../shared/contract.ts';
import type { CrmBridge, CrmState } from '../renderer/firmWorkspaceContract.ts';
import { todayStateSchema, type TodayBridge, type TodayState } from '../renderer/todayContract.ts';
import type { AdminBridge, AdminState } from '../renderer/settingsContract.ts';

/**
 * The bridges, and the whole of what a renderer can reach (specification 14.2).
 *
 * One preload script serves all four windows, because Electron gives a window one
 * preload and a window only ever calls the bridge it was built for. Installing all
 * three is not a widening: every channel below is answered by a main-process handler
 * that exists, and a window that never calls one has reached nothing.
 *
 * Parsing on this side as well as on the main side is not paranoia about our own
 * code: it is what makes the renderer's type a guarantee rather than a hope, and it
 * means a state that grew a field it should not have — a token, a body — fails here
 * instead of reaching the page. `desktopStateSchema` and `todayStateSchema` are
 * `strictObject`, so an extra field is an error.
 *
 * `callieCrm` is the exception, and deliberately. `CrmState` is an interface rather
 * than a Zod schema — G3b composed it from `@fss/contracts` DTOs that are already
 * strict where it matters — so there is nothing here to parse it with. Writing a
 * second schema for it in this file would be a second definition of G3b's contract,
 * and the two would disagree the day one changed.
 */

const invokeDesktop = async (channel: string, argument?: unknown): Promise<DesktopState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return desktopStateSchema.parse(answer);
};

const invokeToday = async (channel: string, argument?: unknown): Promise<TodayState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return todayStateSchema.parse(answer);
};

const invokeCrm = async (channel: string, argument?: unknown): Promise<CrmState> =>
  (await ipcRenderer.invoke(channel, argument)) as CrmState;

/**
 * `callieAdmin` follows `callieCrm` rather than `callieToday`: `AdminState` is
 * composed from `@fss/contracts` schemas that the main-process bridge has already
 * parsed the server's answer with, so a second schema here would be a second
 * definition of the same contract and the two would disagree the day one changed.
 */
const invokeAdmin = async (channel: string, argument?: unknown): Promise<AdminState> =>
  (await ipcRenderer.invoke(channel, argument)) as AdminState;

const bridge: DesktopBridge = {
  state: async () => await invokeDesktop(IPC_CHANNELS.state),
  signIn: async input => await invokeDesktop(IPC_CHANNELS.signIn, input),
  signOut: async () => await invokeDesktop(IPC_CHANNELS.signOut),
  refreshToday: async () => await invokeDesktop(IPC_CHANNELS.refreshToday),
};

const today: TodayBridge = {
  state: async () => await invokeToday(TODAY_IPC_CHANNELS.state),
  refresh: async () => await invokeToday(TODAY_IPC_CHANNELS.refresh),
  expand: async input => await invokeToday(TODAY_IPC_CHANNELS.expand, input),
  collapse: async () => await invokeToday(TODAY_IPC_CHANNELS.collapse),
  snooze: async input => await invokeToday(TODAY_IPC_CHANNELS.snooze, input),
  dial: async input => await invokeToday(TODAY_IPC_CHANNELS.dial, input),
  recordOutcome: async input => await invokeToday(TODAY_IPC_CHANNELS.recordOutcome, input),
};

const crm: CrmBridge = {
  state: async () => await invokeCrm(CRM_IPC_CHANNELS.state),
  openFirm: async input => await invokeCrm(CRM_IPC_CHANNELS.openFirm, input),
  openPipeline: async () => await invokeCrm(CRM_IPC_CHANNELS.openPipeline),
  saveContact: async input => await invokeCrm(CRM_IPC_CHANNELS.saveContact, input),
  changeStage: async input => await invokeCrm(CRM_IPC_CHANNELS.changeStage, input),
  resolveMerge: async input => await invokeCrm(CRM_IPC_CHANNELS.resolveMerge, input),
};

const admin: AdminBridge = {
  state: async () => await invokeAdmin(ADMIN_IPC_CHANNELS.state),
  show: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.show, input),
  saveSetting: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.saveSetting, input),
  openHistory: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.openHistory, input),
  loadDashboard: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.loadDashboard, input),
  createStage: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.createStage, input),
  renameStage: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.renameStage, input),
  reorderStages: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.reorderStages, input),
  retireStage: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.retireStage, input),
  acknowledgeAlert: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.acknowledgeAlert, input),
};

contextBridge.exposeInMainWorld('callie', bridge);
contextBridge.exposeInMainWorld('callieToday', today);
contextBridge.exposeInMainWorld('callieCrm', crm);
contextBridge.exposeInMainWorld('callieAdmin', admin);
