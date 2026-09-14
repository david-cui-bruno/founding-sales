import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const executable = resolve(packageRoot, 'out/operator-pairing.cjs');
const networkGuard = resolve(packageRoot, 'test/fixtures/operatorNetworkDenied.mjs');
const args = ['--account', '123456789012', '--region', 'us-east-1', '--table', 'worker-table',
  '--workspace', 'workspace-one', '--expires', '60', '--scopes', 'events:read', '--output', '/not-authorized/operator-code'];
// Actual built public command, not a copied implementation. Node permissions deny
// child processes and filesystem access except its bundle/guard. The preload
// separately denies network before loading the built executable.
function invoke(input: string[]) {
  return spawnSync(process.execPath, ['--permission', `--allow-fs-read=${executable}`, `--allow-fs-read=${networkGuard}`, '--import', networkGuard, executable, ...input], {
    encoding: 'utf8', timeout: 10_000,
    env: { HOME: '/no-operator-home', AWS_EC2_METADATA_DISABLED: 'true', AWS_PROFILE: 'not-authorized',
      AWS_CONFIG_FILE: '/no-operator-config', AWS_SHARED_CREDENTIALS_FILE: '/no-operator-credentials' },
  });
}
beforeAll(() => {
  execFileSync(process.execPath, [resolve(packageRoot, 'build-operator.mjs')], { timeout: 30_000, stdio: 'pipe' });
}, 35_000);

describe('built operator command offline acceptance', () => {
  it.each([{ input: [] }, { input: ['--help'] }])('shows help without credentials, filesystem or network access: $input', ({ input }) => {
    const response = invoke(input);
    expect(response.error).toBeUndefined(); expect(response.status).toBe(0);
    expect(response.stdout).toContain('Usage: operator-pairing'); expect(response.stderr).toBe('');
  });
  it('validates a dry run without creating output or resolving credentials', () => {
    const response = invoke(args);
    expect(response.status).toBe(0); expect(response.stdout).toContain('No IO performed');
    expect(response.stderr).toBe('');
  });
  it('rejects invalid execution arguments without echoing them', () => {
    const response = invoke([...args, '--execute', '--secret', 'FICTIONAL_SECRET_NO_ECHO']);
    expect(response.status).toBe(2); expect(response.stderr).toContain('Invalid arguments');
    expect(response.stdout + response.stderr).not.toContain('FICTIONAL_SECRET_NO_ECHO');
  });
  it('fails private output reservation before live credentials or issuance', () => {
    const response = invoke([...args, '--execute']);
    expect(response.error).toBeUndefined(); expect(response.status).toBe(1);
    expect(response.stderr).toContain('No pairing issued');
    expect(response.stderr).not.toContain('ERR_ACCESS_DENIED');
    expect(response.stderr).not.toContain('OPERATOR_NETWORK_DENIED');
    expect(response.stdout).toBe('');
  });
  it('proves the network guard rejects a real socket entry point', () => {
    const response = spawnSync(process.execPath, ['--import', networkGuard, '-e', "require('node:net').connect(443, 'example.invalid')"], { encoding: 'utf8', timeout: 10_000, env: {} });
    expect(response.status).toBe(1); expect(response.stderr).toContain('OPERATOR_NETWORK_DENIED');
  });
  it('keeps operator code outside the Lambda archive directory', () => {
    expect(existsSync(executable)).toBe(true);
    expect(existsSync(resolve(packageRoot, 'dist/operator-pairing.cjs'))).toBe(false);
  });
});
