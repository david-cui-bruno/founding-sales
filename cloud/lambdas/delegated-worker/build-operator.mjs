import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
// Separate standalone operator artifact. No Lambda/public-auth entry changes.
// AWS adapter is loaded only for a fully validated execute invocation.
await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  stdin: { contents: `import { parseOperatorArgs, runOperatorPairing } from './src/operatorPairing';
async function main() {
  const args = process.argv.slice(2);
  let parsed;
  try { parsed = parseOperatorArgs(args); } catch { return runOperatorPairing(args); }
  if (parsed === 'help') return runOperatorPairing(args);
  if (!parsed.execute) return runOperatorPairing(args);
  const { operatorAwsDependencies } = await import('./src/operatorPairingAws');
  return runOperatorPairing(args, operatorAwsDependencies);
}
main().then(result => {
  process.exitCode = result.exitCode;
  (result.exitCode === 0 ? process.stdout : process.stderr).write(result.message + '\\n');
}).catch(() => {
  process.exitCode = 1;
  process.stderr.write('Operator failed. Do not blindly retry issuance.\\n');
});`, resolveDir: fileURLToPath(new URL('.', import.meta.url)), sourcefile: 'operator-entry.ts', loader: 'ts' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'out/operator-pairing.cjs',
  plugins: [{ name: 'no-native-runtime', setup(builder) {
    builder.onResolve({ filter: /(?:electron|better-sqlite3|sqlcipher|safeStorage)/ }, () => {
      throw new Error('Forbidden operator dependency');
    });
  } }], logLevel: 'info',
});
