import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.ts';
import { CRM_IPC_CHANNELS } from '../main/crmBridge.ts';
import { TODAY_IPC_CHANNELS } from '../main/todayBridge.ts';
import { SEQUENCE_IPC_CHANNELS } from '../main/sequenceBridge.ts';
import { REPLY_IPC_CHANNELS } from '../main/replyBridge.ts';
import { ADMIN_IPC_CHANNELS } from '../main/settingsBridge.ts';
import { MAILBOX_IPC_CHANNELS } from '../main/mailboxBridge.ts';
import {
  desktopStateSchema,
  mailboxStateSchema,
  type DesktopBridge,
  type DesktopState,
  type MailboxBridge,
  type MailboxState,
} from '../shared/contract.ts';
import type { CrmBridge, CrmState } from '../renderer/firmWorkspaceContract.ts';
import { todayStateSchema, type TodayBridge, type TodayState } from '../renderer/todayContract.ts';
import { replyStateSchema, type ReplyBridge, type ReplyState } from '../renderer/replyContract.ts';
import {
  sequenceStateSchema,
  type SequenceBridge,
  type SequenceState,
} from '../renderer/sequenceContract.ts';
import type { AdminBridge, AdminState } from '../renderer/settingsContract.ts';
import { UPDATE_IPC_CHANNELS, updateStatusSchema, type UpdateBridge, type UpdateStatus } from '../shared/updateContract.ts';

/**
 * The bridges, and the whole of what a renderer can reach (specification 14.2).
 *
 * One preload script serves all five windows, because Electron gives a window one
 * preload. Installing all eight bridges is not a widening: every channel below is
 * answered by a main-process handler that exists, and a window that never calls one has
 * reached nothing. Since lane g65 the main window calls four of them: its Home reads
 * `callie` for the session, `callieMailbox` for the Mailbox row, `callieToday` for the
 * lanes and `callieAdmin` for the sidebar's status, the "Last 7 days" figures and the
 * Needs-you list. The Today window that used to own `callieToday` is gone; Today is the
 * main window's content now (`docs/decisions/g65-today-is-the-home.md`).
 *
 * Parsing on this side as well as on the main side is not paranoia about our own
 * code: it is what makes the renderer's type a guarantee rather than a hope, and it
 * means a state that grew a field it should not have — a token, a body — fails here
 * instead of reaching the page. `desktopStateSchema`, `todayStateSchema` and
 * `replyStateSchema` are `strictObject`, so an extra field is an error. The reply
 * state is the one that carries a message body on purpose, which is exactly why it
 * is parsed on both sides rather than passed through.
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

const invokeMailbox = async (channel: string): Promise<MailboxState> => {
  const answer: unknown = await ipcRenderer.invoke(channel);
  return mailboxStateSchema.parse(answer);
};

const invokeToday = async (channel: string, argument?: unknown): Promise<TodayState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return todayStateSchema.parse(answer);
};

const invokeReplies = async (channel: string, argument?: unknown): Promise<ReplyState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return replyStateSchema.parse(answer);
};

const invokeCrm = async (channel: string, argument?: unknown): Promise<CrmState> =>
  (await ipcRenderer.invoke(channel, argument)) as CrmState;

const invokeSequences = async (channel: string, argument?: unknown): Promise<SequenceState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return sequenceStateSchema.parse(answer);
};

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
  // Lane g65: a window name, checked against WINDOW_TARGETS in the main process.
  openWindow: async input => await invokeDesktop(IPC_CHANNELS.openWindow, input),
};

/**
 * The Mailbox row (release.md 8.0x). Three methods and no disconnect — see
 * `MailboxBridge` in the shared contract for why — and none takes an argument, so
 * nothing the page does can choose a scope, a redirect or a URL to open.
 */
const mailbox: MailboxBridge = {
  state: async () => await invokeMailbox(MAILBOX_IPC_CHANNELS.state),
  refresh: async () => await invokeMailbox(MAILBOX_IPC_CHANNELS.refresh),
  connect: async () => await invokeMailbox(MAILBOX_IPC_CHANNELS.connect),
};

const today: TodayBridge = {
  state: async () => await invokeToday(TODAY_IPC_CHANNELS.state),
  refresh: async input => await invokeToday(TODAY_IPC_CHANNELS.refresh, input),
  expand: async input => await invokeToday(TODAY_IPC_CHANNELS.expand, input),
  collapse: async () => await invokeToday(TODAY_IPC_CHANNELS.collapse),
  snooze: async input => await invokeToday(TODAY_IPC_CHANNELS.snooze, input),
  dial: async input => await invokeToday(TODAY_IPC_CHANNELS.dial, input),
  recordOutcome: async input => await invokeToday(TODAY_IPC_CHANNELS.recordOutcome, input),
  scheduleCallback: async input => await invokeToday(TODAY_IPC_CHANNELS.scheduleCallback, input),
  releasePause: async input => await invokeToday(TODAY_IPC_CHANNELS.releasePause, input),
};

/**
 * Five methods, and none of them closes an opportunity, records a suppression,
 * releases a hold or resumes automation. 12.4 gives those to the deterministic layer
 * or to a person on another surface, and a renderer that cannot name them cannot ask
 * for them however the page is edited later.
 */
const replies: ReplyBridge = {
  state: async () => await invokeReplies(REPLY_IPC_CHANNELS.state),
  refresh: async () => await invokeReplies(REPLY_IPC_CHANNELS.refresh),
  open: async input => await invokeReplies(REPLY_IPC_CHANNELS.open, input),
  collapse: async () => await invokeReplies(REPLY_IPC_CHANNELS.collapse),
  confirm: async input => await invokeReplies(REPLY_IPC_CHANNELS.confirm, input),
};

const crm: CrmBridge = {
  state: async () => await invokeCrm(CRM_IPC_CHANNELS.state),
  openFirm: async input => await invokeCrm(CRM_IPC_CHANNELS.openFirm, input),
  openPipeline: async () => await invokeCrm(CRM_IPC_CHANNELS.openPipeline),
  saveContact: async input => await invokeCrm(CRM_IPC_CHANNELS.saveContact, input),
  changeStage: async input => await invokeCrm(CRM_IPC_CHANNELS.changeStage, input),
  resolveMerge: async input => await invokeCrm(CRM_IPC_CHANNELS.resolveMerge, input),
  // Lane g84: Add firm and Import.
  openAddFirm: async () => await invokeCrm(CRM_IPC_CHANNELS.openAddFirm),
  addFirm: async input => await invokeCrm(CRM_IPC_CHANNELS.addFirm, input),
  openImport: async () => await invokeCrm(CRM_IPC_CHANNELS.openImport),
  previewImport: async input => await invokeCrm(CRM_IPC_CHANNELS.previewImport, input),
  commitImport: async () => await invokeCrm(CRM_IPC_CHANNELS.commitImport),
};

const sequences: SequenceBridge = {
  state: async () => await invokeSequences(SEQUENCE_IPC_CHANNELS.state),
  openSequence: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.openSequence, input),
  createSequence: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.createSequence, input),
  saveDraft: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.saveDraft, input),
  publish: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.publish, input),
  retire: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.retire, input),
  approveTemplate: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.approveTemplate, input),
  enroll: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.enroll, input),
  completeLinkedIn: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.completeLinkedIn, input),
  undoLinkedIn: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.undoLinkedIn, input),
  recordLinkedInResult: async input =>
    await invokeSequences(SEQUENCE_IPC_CHANNELS.recordLinkedInResult, input),
  resumeEnrollment: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.resumeEnrollment, input),
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
  setSendingCap: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.setSendingCap, input),
  recordSendingAuthentication: async input =>
    await invokeAdmin(ADMIN_IPC_CHANNELS.recordSendingAuthentication, input),
  recordHolidayCalendar: async input =>
    await invokeAdmin(ADMIN_IPC_CHANNELS.recordHolidayCalendar, input),
  // Lane g60: the person's own calling number, without which Today has no Call button.
  addCallingNumber: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.addCallingNumber, input),
  attestCallingNumber: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.attestCallingNumber, input),
  retireCallingNumber: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.retireCallingNumber, input),
  // Lane g84: record a state posture, and revoke one.
  recordPosture: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.recordPosture, input),
  revokePosture: async input => await invokeAdmin(ADMIN_IPC_CHANNELS.revokePosture, input),
};

// Lane g83: the update line in Home's sidebar. Two calls with no argument and one
// notification that carries nothing, so the page can neither choose what is installed nor
// learn anything but a state and a version; the state is parsed here like every other.
const invokeUpdate = async (channel: string): Promise<UpdateStatus> => {
  const answer: unknown = await ipcRenderer.invoke(channel);
  return updateStatusSchema.parse(answer);
};

const update: UpdateBridge = {
  state: async () => await invokeUpdate(UPDATE_IPC_CHANNELS.state),
  restart: async () => await invokeUpdate(UPDATE_IPC_CHANNELS.restart),
  onChange: listener => {
    ipcRenderer.on(UPDATE_IPC_CHANNELS.changed, () => {
      listener();
    });
  },
};

contextBridge.exposeInMainWorld('callie', bridge);
contextBridge.exposeInMainWorld('callieMailbox', mailbox);
contextBridge.exposeInMainWorld('callieToday', today);
contextBridge.exposeInMainWorld('callieCrm', crm);
contextBridge.exposeInMainWorld('callieReplies', replies);
contextBridge.exposeInMainWorld('callieSequences', sequences);
contextBridge.exposeInMainWorld('callieAdmin', admin);
contextBridge.exposeInMainWorld('callieUpdate', update);
