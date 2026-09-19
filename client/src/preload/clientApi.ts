import type { DiagnosticsView, V1Command, V1FirmView } from '../../../src/shared/contracts/v1Contract';
import {
  CLIENT_CHANNELS,
  clientStatusSchema,
  commandResultSchema,
  clientPhoneSetupSchema,
  dialRequestSchema,
  dialResultSchema,
  googleActionSchema,
  googleResultSchema,
  pairRequestSchema,
  phoneSetupActionSchema,
  pairResultSchema,
  readRequestSchema,
  readResultSchema,
  v1CommandSchema,
  viewSchemas,
  type ClientPhoneSetup,
  type ClientStatus,
  type CommandResult,
  type DialRequest,
  type DialResult,
  type GoogleAction,
  type GoogleResult,
  type PhoneSetupAction,
  type PairResult,
  type ReadRequest,
  type ReadResult,
  type SettingsView,
  type TodayView,
  type WeekView,
} from '../shared/clientContract';

/**
 * The renderer's whole view of the main process: eight operations, each a request validated before it
 * crosses and a reply validated with the contract's zod schemas after it returns. A view is re-validated
 * per path (`diagnosticsViewSchema` for Diagnostics), so a main process that drifted from the contract is
 * refused here rather than rendered. Nothing else is exposed; there is no token anywhere in these shapes.
 *
 * Slice S2 adds the Firm view as a third readable path and `dial`, which hands one number to Phone.app. The renderer
 * cannot dial an arbitrary number through it: the main process checks the firm, the number and the card's own verdict
 * against the Today view it last served, and handing off is not calling.
 */
export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type ClientApi = {
  status(): Promise<ClientStatus>;
  pair(codeOrPath: string): Promise<PairResult>;
  get(request: { view: '/v1/diagnostics'; kind?: ReadRequest['kind'] }): Promise<ReadResult<DiagnosticsView>>;
  get(request: { view: '/v1/today' }): Promise<ReadResult<TodayView>>;
  get(request: { view: '/v1/settings' }): Promise<ReadResult<SettingsView>>;
  get(request: { view: '/v1/firms'; firmId: string }): Promise<ReadResult<V1FirmView>>;
  get(request: { view: '/v1/week' }): Promise<ReadResult<WeekView>>;
  command(command: V1Command): Promise<CommandResult>;
  dial(request: DialRequest): Promise<DialResult>;
  /** The local Phone.app setup proof on this Mac (S5): read it, confirm it, clear it. Never a dial. */
  phoneSetup(request: PhoneSetupAction): Promise<ClientPhoneSetup>;
  /** The cutover's Google steps (S6): open the consent in the browser, or revoke the old grant. Never a send. */
  google(request: GoogleAction): Promise<GoogleResult>;
  unpair(): Promise<ClientStatus>;
};

export function createClientApi(invoke: Invoke): ClientApi {
  const get = async (raw: ReadRequest): Promise<ReadResult> => {
    const request = readRequestSchema.parse(raw);
    const result = readResultSchema.parse(await invoke(CLIENT_CHANNELS.get, request));
    if (result.outcome !== 'ok') return result;
    return { outcome: 'ok', fetchedAt: result.fetchedAt, view: viewSchemas[request.view].parse(result.view),
      ...(result.source === undefined ? {} : { source: result.source }), ...(result.sentence === undefined ? {} : { sentence: result.sentence }) };
  };
  return {
    status: async () => clientStatusSchema.parse(await invoke(CLIENT_CHANNELS.status)),
    pair: async (codeOrPath) => {
      const request = pairRequestSchema.parse({ codeOrPath });
      return pairResultSchema.parse(await invoke(CLIENT_CHANNELS.pair, request));
    },
    get: get as ClientApi['get'],
    command: async (raw) => {
      const command = v1CommandSchema.parse(raw);
      return commandResultSchema.parse(await invoke(CLIENT_CHANNELS.command, command));
    },
    dial: async (raw) => {
      const request = dialRequestSchema.parse(raw);
      return dialResultSchema.parse(await invoke(CLIENT_CHANNELS.dial, request));
    },
    phoneSetup: async (raw) => {
      const request = phoneSetupActionSchema.parse(raw);
      return clientPhoneSetupSchema.parse(await invoke(CLIENT_CHANNELS.phoneSetup, request));
    },
    google: async (raw) => {
      const request = googleActionSchema.parse(raw);
      return googleResultSchema.parse(await invoke(CLIENT_CHANNELS.google, request));
    },
    unpair: async () => clientStatusSchema.parse(await invoke(CLIENT_CHANNELS.unpair)),
  };
}
