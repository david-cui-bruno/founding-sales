import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.ts';
import { CRM_IPC_CHANNELS } from '../main/crmBridge.ts';
import { SEQUENCE_IPC_CHANNELS } from '../main/sequenceBridge.ts';
import { ADMIN_IPC_CHANNELS } from '../main/settingsBridge.ts';
import { MAILBOX_IPC_CHANNELS } from '../main/mailboxBridge.ts';
import {
  DIAL_IPC_CHANNELS,
  OPERATIONS,
  OPERATION_IPC_CHANNELS,
  type DialBridge,
  type OperationApi,
  type OperationName,
} from '../shared/operations.ts';
import {
  desktopStateSchema,
  mailboxStateSchema,
  navigationTargetOf,
  sessionChangeSchema,
  type DesktopBridge,
  type DesktopState,
  type MailboxBridge,
  type MailboxState,
} from '../shared/contract.ts';
import type { CrmBridge, CrmState } from '../renderer/firmWorkspaceContract.ts';
import { todayStateSchema, type TodayState } from '../renderer/todayContract.ts';
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
 * There is one window (wave 1). The shell reads `callie` for the session,
 * `callieMailbox` for the Mailbox row and `callieAdmin` for the sidebar's status; Today
 * and Replies go through `callieApi`, D4's operation registry — two functions and a
 * closed list of operations, in place of the fifteen hand-written methods those two
 * views had between them; dialling has `callieDial`, because it opens a URI on the
 * operating system rather than answering with one; and Firms, Sequences and the Settings
 * tabs keep their own bridges until U2 converts them. Every channel below is answered by
 * a main-process handler that exists.
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

/**
 * One operation, both ways (D4). The input is checked against the operation's own schema
 * before it leaves the page and the answer against its output schema before it reaches
 * it — the main process does the same on its side, which is what makes the renderer's
 * type a guarantee rather than a hope.
 */
const invokeOperation = async (channel: string, operation: OperationName, input: unknown): Promise<unknown> => {
  const declared = OPERATIONS[operation];
  const answer: unknown = await ipcRenderer.invoke(channel, {
    operation,
    input: declared.input.parse(input ?? {}),
  });
  return declared.output.parse(answer);
};

const api = {
  read: async (operation: OperationName, input: unknown) =>
    await invokeOperation(OPERATION_IPC_CHANNELS.read, operation, input),
  command: async (operation: OperationName, input: unknown) =>
    await invokeOperation(OPERATION_IPC_CHANNELS.command, operation, input),
} as unknown as OperationApi;

/**
 * Dialling. One method, and it takes a firm, a number and a contact — never a URI: the
 * main process re-reads `POST /dial/check` at the press and opens the URI that read
 * answered with, so a renderer that cannot name a `tel:` string cannot ask for one.
 */
const dial: DialBridge = {
  call: async input => todayStateSchema.parse(await ipcRenderer.invoke(DIAL_IPC_CHANNELS.call, input)) as TodayState,
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
  // The menu's ⌘1–⌘4, ⌘, and the deep links. A target outside the closed set is dropped
  // here, so the page is only ever told one of them.
  onNavigate: listener => {
    ipcRenderer.on(IPC_CHANNELS.navigate, (_event, name: unknown) => {
      const target = navigationTargetOf(name);
      if (target !== null) listener(target);
    });
  },
  // A transition the main process saw (1.0.12). Parsed here like everything else that
  // crosses this boundary: a message that is not one of these is not delivered at all.
  onSessionChange: listener => {
    ipcRenderer.on(IPC_CHANNELS.sessionChanged, (_event, raw: unknown) => {
      const parsed = sessionChangeSchema.safeParse(raw);
      if (parsed.success) listener(parsed.data);
    });
  },
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
  // Lane g88: Add to pipeline, Enrol, Confirm this number.
  openOpportunity: async () => await invokeCrm(CRM_IPC_CHANNELS.openOpportunity),
  enroll: async input => await invokeCrm(CRM_IPC_CHANNELS.enroll, input),
  confirmRoute: async input => await invokeCrm(CRM_IPC_CHANNELS.confirmRoute, input),
  // Lane g90: Check again, on an address.
  checkRoute: async input => await invokeCrm(CRM_IPC_CHANNELS.checkRoute, input),
};

const sequences: SequenceBridge = {
  state: async () => await invokeSequences(SEQUENCE_IPC_CHANNELS.state),
  openSequence: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.openSequence, input),
  createSequence: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.createSequence, input),
  // Lane g88: authoring and the resume review.
  createDraft: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.createDraft, input),
  saveDraft: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.saveDraft, input),
  createTemplate: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.createTemplate, input),
  reviewEnrollment: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.reviewEnrollment, input),
  closeReview: async () => await invokeSequences(SEQUENCE_IPC_CHANNELS.closeReview),
  publish: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.publish, input),
  retire: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.retire, input),
  approveTemplate: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.approveTemplate, input),
  enroll: async input => await invokeSequences(SEQUENCE_IPC_CHANNELS.enroll, input),
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
  checkNow: async () => await invokeUpdate(UPDATE_IPC_CHANNELS.checkNow),
  onChange: listener => {
    ipcRenderer.on(UPDATE_IPC_CHANNELS.changed, () => {
      listener();
    });
  },
};

contextBridge.exposeInMainWorld('callie', bridge);
contextBridge.exposeInMainWorld('callieMailbox', mailbox);
contextBridge.exposeInMainWorld('callieApi', api);
contextBridge.exposeInMainWorld('callieDial', dial);
contextBridge.exposeInMainWorld('callieCrm', crm);
contextBridge.exposeInMainWorld('callieSequences', sequences);
contextBridge.exposeInMainWorld('callieAdmin', admin);
contextBridge.exposeInMainWorld('callieUpdate', update);
