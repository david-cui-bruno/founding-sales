import { spawnSync } from 'node:child_process';

export function runEncryptedSqliteNativeProbe({
  executable,
  nativeBinary,
  expectedAbi,
  environment = {},
  probeScript,
  spawn = spawnSync,
}) {
  const result = spawn(executable, [probeScript, nativeBinary], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
    maxBuffer: 65_536,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new Error(`Encrypted SQLite native probe failed for ABI ${expectedAbi}.`);
  }

  let report;
  try {
    report = JSON.parse(String(result.stdout));
  } catch {
    throw new Error(`Encrypted SQLite native probe failed for ABI ${expectedAbi}.`);
  }
  if (
    report === null
    || typeof report !== 'object'
    || Array.isArray(report)
    || JSON.stringify(Object.keys(report).sort())
      !== JSON.stringify(['cipherVersion', 'modules'])
    || report.modules !== expectedAbi
    || typeof report.cipherVersion !== 'string'
    || report.cipherVersion.length === 0
  ) {
    throw new Error(`Encrypted SQLite native probe failed for ABI ${expectedAbi}.`);
  }
  return report;
}
