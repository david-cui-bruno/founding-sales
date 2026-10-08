import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/ipc.ts';
import {
  DIAL_IPC_CHANNELS,
  IMPORT_IPC_CHANNELS,
  OPERATIONS,
  OPERATION_IPC_CHANNELS,
  type DialBridge,
  type ImportBridge,
  type OperationApi,
  type OperationName,
} from '../shared/operations.ts';
import {
  desktopStateSchema,
  actionNavigationSchema,
  navigationTargetOf,
  sessionChangeSchema,
  type DesktopBridge,
  type DesktopState,
} from '../shared/contract.ts';
import { crmStateSchema } from '../renderer/firmWorkspaceContract.ts';
import { briefImportViewSchema } from '../shared/briefImport.ts';
import { recordingsViewSchema, recordingRecoveryViewSchema } from '../shared/recordings.ts';
import { todayStateSchema, type TodayState } from '../renderer/todayContract.ts';
import { UPDATE_IPC_CHANNELS, updateStatusSchema, type UpdateBridge, type UpdateStatus } from '../shared/updateContract.ts';

/**
 * The bridges, and the whole of what a renderer can reach (specification 14.2).
 *
 * There is one window and, since 1.0.13, one way into it: `callieApi`, D4's operation
 * registry — two functions and a closed list — with `callie` for the session, `callieDial`
 * for the one thing that opens a URI on the operating system, `callieImport` for the one
 * thing that opens macOS's file panel, and `callieUpdate` for the update line. Firms,
 * Sequences, Settings and the Mailbox row had forty-eight hand-written methods between
 * them until 1.0.13; they are operations now, and every channel below is answered by a
 * main-process handler that exists.
 *
 * Parsing on this side as well as on the main side is not paranoia about our own
 * code: it is what makes the renderer's type a guarantee rather than a hope, and it
 * means a state that grew a field it should not have — a token, a `tel:` URI, a message
 * body on a Today card — fails here instead of reaching the page. Every operation's
 * output schema is a `strictObject` at its top level, and the reply state, which carries
 * a message body on purpose, is exactly why it is parsed on both sides rather than
 * passed through.
 */

const invokeDesktop = async (channel: string, argument?: unknown): Promise<DesktopState> => {
  const answer: unknown = await ipcRenderer.invoke(channel, argument);
  return desktopStateSchema.parse(answer);
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

/**
 * Importing. One method, and it takes nothing: the main process opens macOS's file
 * panel, reads what the person chose and previews it, so a renderer that cannot name a
 * path cannot ask for one — and the CSV itself never crosses this boundary at all.
 */
const importer: ImportBridge = {
  choose: async () => crmStateSchema.parse(await ipcRenderer.invoke(IMPORT_IPC_CHANNELS.choose)),
  chooseBriefs: async () => briefImportViewSchema.parse(await ipcRenderer.invoke(IMPORT_IPC_CHANNELS.chooseBriefs)),
  chooseRecordingsFolder: async () => recordingsViewSchema.parse(await ipcRenderer.invoke(IMPORT_IPC_CHANNELS.chooseRecordingsFolder)),
  chooseRecordingRecoveryFile: async recordingId => recordingRecoveryViewSchema.parse(await ipcRenderer.invoke(IMPORT_IPC_CHANNELS.chooseRecordingRecoveryFile, recordingId)),
  importRecordingFolder: async () => recordingsViewSchema.parse(await ipcRenderer.invoke(IMPORT_IPC_CHANNELS.importRecordingFolder)),
};

const bridge: DesktopBridge = {
  state: async () => await invokeDesktop(IPC_CHANNELS.state),
  signIn: async input => await invokeDesktop(IPC_CHANNELS.signIn, input),
  signOut: async () => await invokeDesktop(IPC_CHANNELS.signOut),
  // The menu's ⌘1–⌘6, and the deep links. A target outside the closed set is dropped
  // here, so the page is only ever told one of them.
  listDevices: async () => await invokeDesktop(IPC_CHANNELS.devices),
  revokeDevice: async input => await invokeDesktop(IPC_CHANNELS.revokeDevice, { deviceId: input.deviceId }),
  onNavigate: listener => {
    ipcRenderer.on(IPC_CHANNELS.navigate, (_event, name: unknown) => {
      const target = navigationTargetOf(name);
      if (target !== null) listener(target);
    });
  },
  onActionNavigate:listener=>{
    ipcRenderer.on(IPC_CHANNELS.navigateAction,(_event,raw:unknown)=>{
      const parsed=actionNavigationSchema.safeParse(raw);
      if(parsed.success)listener(parsed.data);
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

// Lane g83: the update line in the sidebar. Two calls with no argument and one
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
contextBridge.exposeInMainWorld('callieApi', api);
contextBridge.exposeInMainWorld('callieDial', dial);
contextBridge.exposeInMainWorld('callieImport', importer);
contextBridge.exposeInMainWorld('callieUpdate', update);
