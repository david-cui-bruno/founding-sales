import {
  revealDatabaseResultSchema,
  revealLogDirectoryResultSchema,
  type RevealDatabaseResult,
  type RevealLogDirectoryResult,
} from '../../shared/contracts/shellContract';
import type { IpcClient } from '../ipcClient';

const SHELL_REVEAL_DATABASE_CHANNEL = 'shell:reveal-database';
const SHELL_REVEAL_LOG_DIRECTORY_CHANNEL = 'shell:reveal-log-directory';

export type ShellApi = {
  revealDatabase(): Promise<RevealDatabaseResult>;
  revealLogDirectory(): Promise<RevealLogDirectoryResult>;
};

/**
 * Narrow desktop-shell API: reveal the encrypted database in Finder. The
 * renderer sends no path; the main process resolves the location itself.
 */
export const createShellApi = (client: IpcClient): ShellApi => ({
  revealDatabase: () =>
    client.requestNoInput(SHELL_REVEAL_DATABASE_CHANNEL, revealDatabaseResultSchema),
  revealLogDirectory: () => client.requestNoInput(
    SHELL_REVEAL_LOG_DIRECTORY_CHANNEL,
    revealLogDirectoryResultSchema,
  ),
});
