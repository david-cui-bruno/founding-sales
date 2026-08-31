import type { z } from 'zod';

export type IpcInvoker = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
};

export type IpcClient = {
  request<Request, Response>(
    channel: string,
    requestSchema: z.ZodType<Request>,
    responseSchema: z.ZodType<Response>,
    value: Request,
  ): Promise<Response>;
  requestNoInput<Response>(
    channel: string,
    responseSchema: z.ZodType<Response>,
  ): Promise<Response>;
};

export const createIpcClient = (invoker: IpcInvoker): IpcClient => ({
  request: async <Request, Response>(
    channel: string,
    requestSchema: z.ZodType<Request>,
    responseSchema: z.ZodType<Response>,
    value: Request,
  ) => responseSchema.parse(await invoker.invoke(channel, requestSchema.parse(value))),
  requestNoInput: async <Response>(
    channel: string,
    responseSchema: z.ZodType<Response>,
  ) => responseSchema.parse(await invoker.invoke(channel)),
});
