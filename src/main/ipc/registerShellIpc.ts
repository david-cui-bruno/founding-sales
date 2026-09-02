import {
  revealDatabaseResultSchema,
  type RevealDatabaseResult,
} from '../../shared/contracts/shellContract';
import { registerValidatedIpc } from './registerValidatedIpc';

export const SHELL_REVEAL_DATABASE_CHANNEL = 'shell:reveal-database';

/**
 * Narrow shell surface: the single Finder affordance Settings needs. The
 * provider owns the real path; the channel carries no renderer input.
 */
export type ShellProvider = {
  revealDatabase(): RevealDatabaseResult | Promise<RevealDatabaseResult>;
};

/** Registers exactly the one payload-free shell channel. */
export function registerShellIpc(
  provider: ShellProvider,
  isTrustedRendererUrl?: (url: string) => boolean,
): () => void {
  return registerValidatedIpc<undefined, RevealDatabaseResult>({
    channel: SHELL_REVEAL_DATABASE_CHANNEL,
    requestSchema: null,
    responseSchema: revealDatabaseResultSchema,
    handler: () => provider.revealDatabase(),
    isTrustedRendererUrl,
  });
}
