import { ipcMain } from 'electron';
import type { z } from 'zod';

import { validateSender } from './validateSender';

export type RegisterValidatedIpcOptions<Request, Response> = {
  channel: string;
  /** Opt-in fixed error for secret-bearing feature boundaries. Never logs causes. */
  safeErrorCode?: string;
  requestSchema: z.ZodType<Request> | null;
  responseSchema: z.ZodType<Response>;
  handler(request: Request): Response | Promise<Response>;
  isTrustedRendererUrl?: (url: string) => boolean;
};

export function registerValidatedIpc<Request, Response>(
  options: RegisterValidatedIpcOptions<Request, Response>,
): () => void {
  ipcMain.handle(options.channel, async (event, ...args: unknown[]) => {
    try {
      validateSender(event, options.isTrustedRendererUrl);

      if (options.requestSchema === null && args.length !== 0) {
        throw new Error(`${options.channel} accepts no arguments.`);
      }

      if (options.requestSchema !== null && args.length !== 1) {
        throw new Error(`${options.channel} requires one request.`);
      }

      const request =
        options.requestSchema === null
          ? undefined
          : options.requestSchema.parse(args[0]);

      return options.responseSchema.parse(
        await options.handler(request as Request),
      );
    } catch (error) {
      if (options.safeErrorCode !== undefined) throw new Error(options.safeErrorCode);
      throw error;
    }
  });

  let registered = true;

  return () => {
    if (!registered) {
      return;
    }

    registered = false;
    ipcMain.removeHandler(options.channel);
  };
}
