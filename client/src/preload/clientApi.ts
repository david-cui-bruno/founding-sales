import type { DiagnosticsView, V1Command } from '../../../src/shared/contracts/v1Contract';
import {
  CLIENT_CHANNELS,
  clientStatusSchema,
  commandResultSchema,
  pairRequestSchema,
  pairResultSchema,
  readRequestSchema,
  readResultSchema,
  v1CommandSchema,
  viewSchemas,
  type ClientStatus,
  type CommandResult,
  type PairResult,
  type ReadRequest,
  type ReadResult,
  type TodayView,
} from '../shared/clientContract';

/**
 * The renderer's whole view of the main process: five operations, each a request validated before it
 * crosses and a reply validated with the contract's zod schemas after it returns. A view is re-validated
 * per path (`diagnosticsViewSchema` for Diagnostics), so a main process that drifted from the contract is
 * refused here rather than rendered. Nothing else is exposed; there is no token anywhere in these shapes.
 */
export type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export type ClientApi = {
  status(): Promise<ClientStatus>;
  pair(codeOrPath: string): Promise<PairResult>;
  get(request: { view: '/v1/diagnostics'; kind?: ReadRequest['kind'] }): Promise<ReadResult<DiagnosticsView>>;
  get(request: { view: '/v1/today' }): Promise<ReadResult<TodayView>>;
  command(command: V1Command): Promise<CommandResult>;
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
    unpair: async () => clientStatusSchema.parse(await invoke(CLIENT_CHANNELS.unpair)),
  };
}
