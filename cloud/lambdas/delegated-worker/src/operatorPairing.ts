import type { DynamoAdapter } from './dynamoStore';
import type { WorkerScope } from './workerAuth';

const HELP = 'Usage: operator-pairing --account 12_DIGITS --region REGION --table TABLE --workspace WORKSPACE --expires 30..600 --scopes events:read[,commands:write,google:grant,pairing:revoke] --output /private/directory/file [--rotate PAIRING_ID] [--execute]\nDefault: dry-run, no filesystem, credentials or network access. Standalone execute verifies AWS identity after private output reservation. Workspace IDs beginning -- are not supported. Never pass a code or credential as an argument.\n--rotate PAIRING_ID: mint a rotation code for an existing, unrevoked pairing instead of a fresh pairing. The pairing id and every record bound to it stay; redeeming the code replaces both credentials at the next generation with the given scopes, which must keep commands:write and events:read. The previous credentials stop working at redemption.';
const hasControlCharacters = (value: string) => [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const SCOPES = ['commands:write', 'events:read', 'google:grant', 'pairing:revoke'] as const;
const DESKTOP_SCOPES = ['commands:write', 'events:read'] as const;
/** Lower-case RFC 4122 form only, the shape WorkerAuth stores and the desktop shows. */
const PAIRING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type PairingOptions = {
  account: string; region: string; table: string; workspace: string;
  expires: number; scopes: WorkerScope[]; output: string; execute: boolean;
  /** The existing pairing whose credentials the code will rotate, or null for a fresh pairing. */
  rotate: string | null;
};
export type OperatorResult = { exitCode: number; message: string };
const result = (exitCode: number, message: string): OperatorResult => ({ exitCode, message });

/** Pure validation. Never echo untrusted arguments, even on parse failures. */
export function parseOperatorArgs(args: readonly string[]): PairingOptions | 'help' {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return 'help';
  const fields = new Map<string, string>(); let execute = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--execute') {
      if (execute) throw new Error('invalid_arguments');
      execute = true; continue;
    }
    if (!['--account', '--region', '--table', '--workspace', '--expires', '--scopes', '--output', '--rotate'].includes(key)
      || fields.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('invalid_arguments');
    fields.set(key, args[++i]!);
  }
  const get = (name: string) => fields.get(`--${name}`) ?? '';
  const account = get('account'), region = get('region'), table = get('table'), workspace = get('workspace');
  const expiry = get('expires'), output = get('output'), scopes = get('scopes').split(',');
  const rotate = fields.has('--rotate') ? get('rotate') : null;
  // Use the Terraform workspace character contract; CLI values beginning -- remain reserved for flags.
  if (!/^\d{12}$/.test(account) || !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)
    || !/^[A-Za-z0-9_.-]{3,255}$/.test(table) || !/^[A-Za-z0-9_-]{1,128}$/.test(workspace)
    || !/^\d{2,3}$/.test(expiry) || Number(expiry) < 30 || Number(expiry) > 600
    || scopes.length < 1 || scopes.length > 4 || new Set(scopes).size !== scopes.length
    || scopes.some(scope => !SCOPES.some(allowed => allowed === scope))
    || !output.startsWith('/') || output.length > 4096 || hasControlCharacters(output)
    || output.split('/').slice(1).some(part => !part || part === '.' || part === '..')) throw new Error('invalid_arguments');
  // A rotation names one existing pairing and may never drop the two scopes the desktop pairing needs.
  if (rotate !== null && (!PAIRING_ID.test(rotate) || DESKTOP_SCOPES.some(scope => !scopes.includes(scope)))) throw new Error('invalid_arguments');
  return { account, region, table, workspace, expires: Number(expiry), scopes: scopes as WorkerScope[], output, execute, rotate };
}

/** Narrow trusted composition seam, not an HTTP route. The standalone adapter
 * must use STS GetCallerIdentity and DynamoDB DescribeTable with the SAME explicit
 * credential identity, fixed regional AWS endpoints, no logger, and maxAttempts=1.
 * Do not wire default credential discovery into this module's import/dry-run path.
 */
export interface OperatorCloud {
  getCallerIdentity(): Promise<{ Account?: string; Arn?: string }>;
  describeTable(): Promise<{ TableName?: string; TableArn?: string; TableStatus?: string }>;
  dynamo: DynamoAdapter;
  close(): void;
}
export interface PrivateOutput {
  /** Persists the code to the exclusively reserved final file, fsyncs file and directory. */
  save(code: string): Promise<void>;
  close(): Promise<void>;
}
export interface OperatorDependencies {
  reserveOutput(path: string): Promise<PrivateOutput>;
  connect(options: PairingOptions, policy: { maxAttempts: 1 }): Promise<OperatorCloud>;
}

/** Does not print, throw provider errors, or return secrets. Without injected dependencies, library --execute intentionally fails closed without IO.
 * Empty reserved files are retained on failure as a visible no-retry marker.
 */
export async function runOperatorPairing(args: readonly string[], deps?: OperatorDependencies): Promise<OperatorResult> {
  let options: PairingOptions | 'help';
  try { options = parseOperatorArgs(args); } catch { return result(2, 'Invalid arguments. Use --help.'); }
  if (options === 'help') return result(0, HELP);
  if (!options.execute) {
    return result(0, options.rotate === null ? 'Dry-run valid. No IO performed, identity and destination are NOT verified. No pairing issued.'
      : 'Dry-run valid. No IO performed, identity, destination and pairing are NOT verified. No rotation issued.');
  }
  if (!deps) return result(2, 'Execution unavailable: approved STS identity adapter required. No IO performed.');
  let output: PrivateOutput | undefined, cloud: OperatorCloud | undefined;
  let issuanceStarted = false, saved = false;
  let outcome = result(1, 'Preflight failed. No pairing issued. Reserved output, if any, is retained.');
  try {
    output = await deps.reserveOutput(options.output);
    cloud = await deps.connect(options, { maxAttempts: 1 });
    const caller = await cloud.getCallerIdentity();
    const table = await cloud.describeTable();
    const partition = options.region.startsWith('cn-') ? 'aws-cn' : options.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws';
    const arn = `arn:${partition}:dynamodb:${options.region}:${options.account}:table/${options.table}`;
    if (caller.Account !== options.account || !caller.Arn?.startsWith(`arn:${partition}:`)
      || caller.Arn.split(':')[4] !== options.account || table.TableName !== options.table
      || table.TableArn !== arn || table.TableStatus !== 'ACTIVE') {
      outcome = result(1, 'Identity mismatch or table not active. No pairing issued. Reserved output retained.');
    } else {
      const { WorkerAuth } = await import('./workerAuth');
      const auth = new WorkerAuth({ dynamo: cloud.dynamo, tableName: arn, workspaceId: options.workspace,
        clock: { now: () => new Date().toISOString() } });
      issuanceStarted = true;
      if (options.rotate === null) {
        const grant = await auth.issuePairing({ scopes: options.scopes, expiresInSeconds: options.expires });
        await output.save(grant.code);
        saved = true;
        outcome = result(0, 'Pairing code saved to private output. No code printed.');
      } else {
        let rotation: { code: string } | null = null;
        try { rotation = await auth.issueRotation({ pairingId: options.rotate, scopes: options.scopes, expiresInSeconds: options.expires }); }
        catch (error) {
          // issueRotation refuses an unknown or revoked pairing before it writes anything; every other failure stays uncertain.
          if (!(error instanceof Error) || error.message !== 'pairing_unavailable') throw error;
          issuanceStarted = false;
          outcome = result(1, 'Pairing unknown or revoked. No rotation issued. Reserved output retained.');
        }
        if (rotation) {
          await output.save(rotation.code);
          saved = true;
          outcome = result(0, 'Rotation code saved to private output. No code printed. The current credential keeps working until the code is redeemed.');
        }
      }
    }
  } catch {
    if (issuanceStarted) outcome = result(1, 'Issuance or output durability uncertain. Do NOT blindly retry. Output may be empty or partial. Treat any code as active until expiry, reconcile privately.');
  } finally {
    try { await output?.close(); } catch {
      outcome = result(1, saved ? 'Code saved, but output close failed. Do NOT retry issuance. Inspect output privately.'
        : issuanceStarted ? 'Issuance uncertain and output close failed. Do NOT blindly retry. Reconcile privately.'
          : 'Output close failed. No pairing issued. Reserved output retained.');
    }
    try { cloud?.close(); } catch {
      if (outcome.exitCode === 0) outcome = result(1, 'Code saved, but client cleanup failed. Do NOT retry issuance.');
    }
  }
  return outcome;
}

/** POSIX-only trusted local operator storage. Atomic O_EXCL creation, never
 * overwrite or rename, no secret temporary file. Contents are NOT atomically
 * published: a crash may leave an empty/partial private final file. Success is
 * reported only after file AND parent fsync. Same-UID/root attackers are outside
 * this local trust boundary. Parent and every ancestor must not be symlinks or
 * writable by other users. Parent must be owned by operator and private 0700.
 */
export async function reservePrivateOutput(path: string): Promise<PrivateOutput> {
  try { return await reserveOutputFile(path); } catch { throw new Error('output_unavailable'); }
}
async function reserveOutputFile(path: string): Promise<PrivateOutput> {
  const fs = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const { dirname } = await import('node:path');
  if (!path.startsWith('/') || path.split('/').slice(1).some(part => !part || part === '.' || part === '..')
    || hasControlCharacters(path) || !process.getuid) throw new Error('output_unavailable');
  const uid = process.getuid(), parent = dirname(path);
  for (let directory = parent;; directory = dirname(directory)) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0
      || (stat.uid !== uid && stat.uid !== 0)
      || (directory === parent && (stat.uid !== uid || (stat.mode & 0o777) !== 0o700))) throw new Error('output_unavailable');
    if (directory === '/') break;
  }
  const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let file: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    file = await fs.open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error('output_unavailable');
    await file.sync(); await directory.sync(); // Verify durable destination BEFORE issuance.
    const handle = file;
    return {
      save: async code => { await handle.writeFile(`${code}\n`, 'utf8'); await handle.sync(); await directory.sync(); },
      close: async () => { try { await handle.close(); } finally { await directory.close(); } },
    };
  } catch {
    try { await file?.close(); } catch { /* Never expose filesystem details. */ }
    try { await directory.close(); } catch { /* No secret temp files to clean up. */ }
    throw new Error('output_unavailable');
  }
}
