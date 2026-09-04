import {
  revealDatabaseResultSchema,
  revealLogDirectoryResultSchema,
  type RevealDatabaseResult,
  type RevealLogDirectoryResult,
} from '../../shared/contracts/shellContract';
import { registerValidatedIpc } from './registerValidatedIpc';

export const SHELL_REVEAL_DATABASE_CHANNEL = 'shell:reveal-database';
export const SHELL_REVEAL_LOG_DIRECTORY_CHANNEL = 'shell:reveal-log-directory';

/**
 * Narrow shell surface: the single Finder affordance Settings needs. The
 * provider owns the real path; the channel carries no renderer input.
 */
export type ShellProvider = {
  revealDatabase(): RevealDatabaseResult | Promise<RevealDatabaseResult>;
  revealLogDirectory(): RevealLogDirectoryResult | Promise<RevealLogDirectoryResult>;
};

/** Registers the two payload-free shell channels. */
export function registerShellIpc(
  provider: ShellProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  const unregisterDatabase = registerValidatedIpc<undefined, RevealDatabaseResult>({
    channel: SHELL_REVEAL_DATABASE_CHANNEL,
    requestSchema: null,
    responseSchema: revealDatabaseResultSchema,
    handler: () => provider.revealDatabase(),
    isTrustedRendererUrl,
  });
  const unregisterLogs = registerValidatedIpc<undefined, RevealLogDirectoryResult>({
    channel: SHELL_REVEAL_LOG_DIRECTORY_CHANNEL,
    requestSchema: null,
    responseSchema: revealLogDirectoryResultSchema,
    handler: () => provider.revealLogDirectory(),
    isTrustedRendererUrl,
  });
  return () => {
    unregisterLogs();
    unregisterDatabase();
  };
}
