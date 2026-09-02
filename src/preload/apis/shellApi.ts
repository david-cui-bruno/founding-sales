import {
  revealDatabaseResultSchema,
  type RevealDatabaseResult,
} from '../../shared/contracts/shellContract';
import type { IpcClient } from '../ipcClient';

const SHELL_REVEAL_DATABASE_CHANNEL = 'shell:reveal-database';

export type ShellApi = {
  revealDatabase(): Promise<RevealDatabaseResult>;
};

/**
 * Narrow desktop-shell API: reveal the encrypted database in Finder. The
 * renderer sends no path; the main process resolves the location itself.
 */
export const createShellApi = (client: IpcClient): ShellApi => ({
  revealDatabase: () =>
    client.requestNoInput(SHELL_REVEAL_DATABASE_CHANNEL, revealDatabaseResultSchema),
});
