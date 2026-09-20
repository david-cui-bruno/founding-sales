import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.ts';
import { CRM_IPC_CHANNELS } from '../main/crmBridge.ts';
import { TODAY_IPC_CHANNELS } from '../main/todayBridge.ts';
import { SEQUENCE_IPC_CHANNELS } from '../main/sequenceBridge.ts';
import { REPLY_IPC_CHANNELS } from '../main/replyBridge.ts';
import { desktopStateSchema, type DesktopBridge, type DesktopState } from '../shared/contract.ts';
import type { CrmBridge, CrmState } from '../renderer/firmWorkspaceContract.ts';
import { todayStateSchema, type TodayBridge, type TodayState } from '../renderer/todayContract.ts';
import { replyStateSchema, type ReplyBridge, type ReplyState } from '../renderer/replyContract.ts';
import {
  sequenceStateSchema,
  type SequenceBridge,
  type SequenceState,
} from '../renderer/sequenceContract.ts';

/**
 * The bridges, and the whole of what a renderer can reach (specification 14.2).
 *
 * One preload script serves all five windows, because Electron gives a window one
 * preload and a window only ever calls the bridge it was built for. Installing all
 * five is not a widening: every channel below is answered by a main-process handler
 * that exists, and a window that never calls one has reached nothing.
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

contextBridge.exposeInMainWorld('callie', bridge);
contextBridge.exposeInMainWorld('callieToday', today);
contextBridge.exposeInMainWorld('callieCrm', crm);
contextBridge.exposeInMainWorld('callieReplies', replies);
contextBridge.exposeInMainWorld('callieSequences', sequences);
