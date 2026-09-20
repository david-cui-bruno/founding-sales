import { spawn } from 'node:child_process';

/**
 * The macOS Keychain, as the one place a device secret is kept
 * (specification 5.3: "The device secret is stored only as a server hash and in
 * macOS Keychain").
 *
 * Two things matter about this file.
 *
 * **The secret never appears in an argument vector.** `security add-generic-password`
 * accepts `-w` with a value, and every example on the internet uses it — which puts
 * the password in `ps` output for every user on the Mac. Given `-w` with nothing
 * after it, `security` reads the password from standard input instead, so that is
 * what this does. `keychainCommand()` is exported and tested for exactly that: no
 * argument it builds ever contains the secret.
 *
 * **The process runner is injected.** A test never writes to the real login keychain.
 * The unit tests use an in-memory vault and a fake runner; the adapter that actually
 * shells out is only assembled by the Electron main process.
 */

export interface SecretVault {
  read(account: string): Promise<string | null>;
  write(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => Promise<ProcessResult>;

export type KeychainOperation = 'read' | 'write' | 'remove';

export interface KeychainCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Present only for `write`, and this is the only place the secret appears. */
  readonly stdin?: string;
}

export const SECURITY_BINARY = '/usr/bin/security';

/**
 * The exact process invocation for one Keychain operation.
 *
 * `-U` updates an existing item rather than failing; `-w` with no following value
 * makes `security` read the password from standard input, which it asks for twice.
 */
export function keychainCommand(
  operation: KeychainOperation,
  input: { readonly service: string; readonly account: string; readonly secret?: string },
): KeychainCommand {
  const identity = ['-a', input.account, '-s', input.service];
  switch (operation) {
    case 'read':
      return { command: SECURITY_BINARY, args: ['find-generic-password', ...identity, '-w'] };
    case 'write':
      return {
        command: SECURITY_BINARY,
        args: ['add-generic-password', ...identity, '-U', '-T', '', '-w'],
        stdin: `${input.secret ?? ''}\n${input.secret ?? ''}\n`,
      };
    case 'remove':
      return { command: SECURITY_BINARY, args: ['delete-generic-password', ...identity] };
  }
}

export class KeychainError extends Error {
  constructor(readonly reason: 'unavailable' | 'write_failed' | 'remove_failed') {
    super(`keychain_${reason}`);
    this.name = 'KeychainError';
  }
}

export interface KeychainVaultOptions {
  /** The Keychain service name. One per installation channel, never per secret. */
  readonly service: string;
  readonly runner?: ProcessRunner;
}

/** The real runner. Nothing in it logs, and the child inherits no environment it needs. */
export const spawnRunner: ProcessRunner = async (command, args, stdin) =>
  await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });

export function createKeychainVault(options: KeychainVaultOptions): SecretVault {
  const runner = options.runner ?? spawnRunner;
  const run = async (operation: KeychainOperation, account: string, secret?: string): Promise<ProcessResult> => {
    const invocation = keychainCommand(operation, {
      service: options.service,
      account,
      ...(secret === undefined ? {} : { secret }),
    });
    return await runner(invocation.command, invocation.args, invocation.stdin);
  };

  return {
    async read(account) {
      const result = await run('read', account);
      // `security` exits 44 when the item is not there. Anything else non-zero is a
      // real failure, but an absent secret is a normal state: this Mac is not paired.
      if (result.code !== 0) return null;
      const value = result.stdout.trim();
      return value.length === 0 ? null : value;
    },
    async write(account, secret) {
      const result = await run('write', account, secret);
      if (result.code !== 0) throw new KeychainError('write_failed');
    },
    async remove(account) {
      const result = await run('remove', account);
      // Removing something that is not there is the state we wanted.
      if (result.code !== 0 && result.code !== 44) throw new KeychainError('remove_failed');
    },
  };
}

/** An in-memory vault, for the unit tests and for nothing else. */
export function createMemoryVault(): SecretVault & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    async read(account) {
      return await Promise.resolve(entries.get(account) ?? null);
    },
    async write(account, secret) {
      entries.set(account, secret);
      await Promise.resolve();
    },
    async remove(account) {
      entries.delete(account);
      await Promise.resolve();
    },
  };
}
