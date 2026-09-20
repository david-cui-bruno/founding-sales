import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeychainVault, keychainCommand, spawnRunner } from '../../src/main/index.ts';
import { HOST_TESTS_ENABLED } from './support/hostGate.ts';

/**
 * The real macOS Keychain, through the real `/usr/bin/security`.
 *
 * `docs/decisions/g2-desktop-test-layers.md` names this as one of the things the
 * unit tests deliberately did not claim: "that `security add-generic-password`
 * behaves as `keychainCommand` expects against a real login keychain". It does not,
 * quite — see `docs/decisions/g13-keychain-acl.md`. An item written with `-T ''` has
 * an access control list that trusts no application, so reading it back raises a
 * modal authorization dialog: the app blocks on a window a person may not be looking
 * at, and a headless runner blocks forever. This test is how that was found.
 *
 * The item goes in the login keychain, because `add-generic-password` reads the
 * password from standard input only when `-w` is the last argument, and the keychain
 * to write to is a trailing positional that `-w` would swallow. The service name is
 * unique per run and the item is removed in `afterEach`, so nothing of this survives
 * the test.
 */

const service = `com.callie.fss.desktop.hosttest.${randomUUID()}`;
const account = 'device-secret';

afterEach(async () => {
  if (!HOST_TESTS_ENABLED) return;
  const remove = keychainCommand('remove', { service, account });
  await spawnRunner(remove.command, remove.args);
});

describe.skipIf(!HOST_TESTS_ENABLED)('the Keychain adapter against /usr/bin/security', () => {
  it('writes, reads back, updates and removes a secret without a prompt', async () => {
    const vault = createKeychainVault({ service });
    const first = randomUUID();
    const second = randomUUID();

    // Nothing is stored yet: "not paired", not an error.
    await expect(vault.read(account)).resolves.toBeNull();

    await vault.write(account, first);
    await expect(vault.read(account)).resolves.toBe(first);

    // `-U` updates in place rather than failing on a second write.
    await vault.write(account, second);
    await expect(vault.read(account)).resolves.toBe(second);

    await vault.remove(account);
    await expect(vault.read(account)).resolves.toBeNull();

    // Removing what is already gone is the state we wanted, not a failure.
    await expect(vault.remove(account)).resolves.toBeUndefined();
  }, 60_000);

  it('keeps the secret out of the argument vector it actually runs', async () => {
    const secret = randomUUID();
    const invocation = keychainCommand('write', { service, account, secret });

    expect(invocation.args).not.toContain(secret);
    expect(invocation.args.at(-1)).toBe('-w');

    const result = await spawnRunner(invocation.command, invocation.args, invocation.stdin);
    expect(result.code).toBe(0);
    // `security` prompts on standard error for the password it read from standard
    // input; neither stream ever carries the value back.
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }, 60_000);
});
