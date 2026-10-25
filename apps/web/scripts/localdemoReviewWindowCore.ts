import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ReviewReceipt = {
  version: 1;
  label: string;
  target: string;
  directory: string;
  node: string;
  script: string;
  createdAt: string;
  minutes: number;
  state: 'starting' | 'ready' | 'stopping' | 'failed';
  controls: { status: string; stop: string; log: string };
  supervisorPid?: number;
  resources?: Record<string, unknown>;
};
export const reviewDirectory = (): string => join(tmpdir(), `fss-local-review-${process.getuid!()}`);
export const launchctl = (args: string[]): string => execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
export const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function checkReviewStart(env: NodeJS.ProcessEnv, platform = process.platform): number {
  if (platform !== 'darwin') throw Error('Independent review windows require macOS launchd. Use plain foreground localdemo elsewhere.');
  if (env['FSS_SYNTHETIC_LOCAL_DEMO'] !== '1') throw Error('Explicit FSS_SYNTHETIC_LOCAL_DEMO=1 required');
  if (Object.keys(env).some(key => /^(?:FSS_TEST_(?:POSTGRES_URL|CLUSTER_URL|TEMPLATE_DATABASE)|DATABASE_URL|PGHOST|PGPORT|PGDATABASE|PGUSER|PGPASSWORD|AWS_|GOOGLE_|VERTEX_|FSS_BROWSER_|FSS_PRODUCTION_)/u.test(key) && (key.startsWith('FSS_TEST_') || env[key]))) throw Error('Inherited database/provider/browser configuration refused. Use a clean environment.');
  const minutes = Number(env['FSS_LOCAL_DEMO_MINUTES'] ?? '20');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) throw Error('Demo lifetime must be 1..30 minutes');
  return minutes;
}

/** Refuse arbitrary paths, symlinks, foreign users and malformed service targets.
 * Control uses the unique launchd service, never a reusable PID or broad kill. */
export async function readReviewReceipt(directory = reviewDirectory()): Promise<ReviewReceipt> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077) !== 0) throw Error('Unsafe review directory');
  const file = join(directory, 'receipt.json');
  const receiptStat = await lstat(file);
  if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.uid !== process.getuid!() || (receiptStat.mode & 0o077) !== 0) throw Error('Unsafe review receipt');
  const receipt = JSON.parse(await readFile(file, 'utf8')) as ReviewReceipt;
  if (receipt.version !== 1 || receipt.directory !== directory || !/^dev\.callie\.local-review\.[a-f0-9-]{36}$/u.test(receipt.label) || receipt.target !== `gui/${process.getuid!()}/${receipt.label}` || typeof receipt.script !== 'string' || typeof receipt.node !== 'string') throw Error('Invalid owned review receipt');
  return receipt;
}

export async function assertOwnedService(receipt: ReviewReceipt, inspect = launchctl): Promise<string> {
  const listing = inspect(['print', receipt.target]);
  const plist = await realpath(join(receipt.directory, 'review.plist'));
  if (!listing.includes(`path = ${plist}`) || !listing.includes(`program = ${receipt.node}`) || !listing.includes(receipt.script) || !listing.includes(receipt.directory)) throw Error('Review service ownership mismatch. Refusing control.');
  return listing;
}

export function reviewPlist(receipt: ReviewReceipt, env: NodeJS.ProcessEnv): string {
  const args = [receipt.node, '--experimental-transform-types', '--disable-warning=ExperimentalWarning', receipt.script, 'supervise', receipt.directory];
  const environment = { HOME: env['HOME'] ?? '', PATH: env['PATH'] ?? '', TMPDIR: tmpdir(), LC_ALL: 'en_US.UTF-8', FSS_SYNTHETIC_LOCAL_DEMO: '1', FSS_LOCAL_DEMO_MINUTES: String(receipt.minutes) };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(receipt.label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(process.cwd())}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>120</integer>
<key>StandardOutPath</key><string>${xml(join(receipt.directory, 'runtime.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(receipt.directory, 'runtime.log'))}</string>
</dict></plist>\n`;
}
