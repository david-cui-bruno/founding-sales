import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

import { REPLY_TEMPLATE_SEEDS } from './outreach/templates/replyTemplateSeeds';
import { REPLY_TEMPLATE_IDS, type ReplyTemplateId } from '../shared/contracts/replyTemplateContract';
import { cutoverExportSchema, CUTOVER_EXPORT_KIND, CUTOVER_EXPORT_MAX, CUTOVER_EXPORT_VERSION,
  type CutoverCallback, type CutoverExport, type CutoverNeverCall, type CutoverPhone, type CutoverTemplate } from '../shared/contracts/cutoverExportContract';
import { resolveApplicationPaths, type ApplicationPaths } from './applicationPaths';
import { PhoneRouteSettings } from './communications/phoneRouteSettings';
import { applyWorkspaceKey, createRawDatabase, type RawDatabase } from './db/sqliteDriver';
import { SafeStorageKeyProtector, type AsyncSafeStorage } from './security/safeStorageKeyProtector';
import { WorkspaceKeyStore } from './security/workspaceKeyStore';
import type { WorkspaceKey } from './security/workspaceKeyTypes';

/**
 * The one-off read-only export of the cutover (slice S6, build item 2). This is the only old-app code the rebuild
 * carries, and the only step of the cutover that opens the old database at all.
 *
 * Three record kinds live only here and nowhere on the worker — the callbacks David promised on the phone
 * (`pm_account_callbacks`), the never-call marks he recorded (`pm_account_suppression_tombstones`) and any
 * template body he edited away from the seeded text (`email_templates`) — plus the local phone setup status,
 * which the new client needs so Settings can say whether this Mac was ever set up to hand a number to Phone.app.
 * Nothing else is read: no mailbox content, no evidence, no events, no keys and no envelopes. The file carries
 * firm ids, dates, David's own notes, his own template text and one sha256 digest of the local phone proof, and
 * he can read the whole of it before the import uses it.
 *
 * Three refusals stand in front of it. It runs only as the packaged host's second reserved mode. It refuses while
 * the app is open, because a single-instance lock it cannot take means another process holds the database. And it
 * opens the database with a genuinely read-only SQLite connection (`readonly`, `fileMustExist`) through the
 * existing key protector, so the export cannot write to the old store even by accident.
 */

const COMMAND = '--callie-export-cutover';
const PRODUCT = 'Callie Founder Sales System';
const FORBIDDEN_ENV = /^(?:CALLIE_|ELECTRON_|NODE_|DYLD_|XDG_)/;
/** Where the file lands. The same folder David already knows for his verified backups. */
export const CUTOVER_EXPORT_DIRECTORY_NAME = 'Callie Backups';
export const cutoverExportFileName = (date: string): string => `cutover-export-${date}.json`;

export type CutoverExportCounts = { callbacks: number; neverCall: number; templates: number };
export type CutoverExportReport = Readonly<{
  kind: 'cutover_export';
  path: string;
  counts: CutoverExportCounts;
  /** The size of the file written and the sha256 of its bytes, so the import can be checked against what was written. */
  bytes: number;
  sha256: string;
  /** The old app's schema version the export was read at. */
  schemaVersion: number;
  phone: CutoverPhone['status'];
}>;

export class CutoverExportRefusedError extends Error {
  constructor(readonly reason: 'invocation' | 'host' | 'lock' | 'paths' | 'key' | 'read' | 'write' | 'shape') {
    super(`CUTOVER_EXPORT_FAILED ${reason}`);
    this.name = 'CutoverExportRefusedError';
  }
}
const refuse = (reason: CutoverExportRefusedError['reason']): never => { throw new CutoverExportRefusedError(reason); };

export function isCutoverExportInvocation(args: readonly string[]): boolean {
  return args.some(arg => arg.startsWith(COMMAND));
}
export function validateCutoverExportInvocation(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (args.length !== 1 || args[0] !== COMMAND || Object.keys(env).some(name => FORBIDDEN_ENV.test(name))) refuse('invocation');
}

const callbackRowSchema = { columns: ['account_id', 'due_on', 'note', 'state', 'source_command_id', 'created_at'] } as const;
type CallbackRow = { account_id: string; due_on: string; note: string | null; state: string; source_command_id: string; created_at: string };
type TombstoneRow = { account_id: string; observed_at: string; source: string; evidence_ref: string };
type TemplateRow = { id: string; subject: string; body: string; revision: number; updated_at: string };

/** The seeded body of one template, or null for an id the seeds do not name. Pure. */
const seedBodyOf = (templateId: string): { subject: string; body: string } | null => {
  const seed = REPLY_TEMPLATE_SEEDS.find(entry => entry.id === templateId);
  return seed ? { subject: seed.subject, body: seed.body } : null;
};

/**
 * Everything the export carries, read from one open read-only connection. Every row the contract refuses is
 * dropped rather than coerced, and the counts in the file are the counts of what is actually in it.
 */
export function readCutoverExport(raw: RawDatabase, input: { exportedAt: string; phone: CutoverPhone }): CutoverExport {
  const schemaVersion = Number((raw.prepare('SELECT schema_version AS v FROM app_meta WHERE singleton=1').get() as { v?: unknown } | undefined)?.v ?? 0);
  const callbackRows = raw.prepare(`SELECT ${callbackRowSchema.columns.join(',')} FROM pm_account_callbacks ORDER BY due_on, account_id`)
    .all() as CallbackRow[];
  const callbacks: CutoverCallback[] = [];
  for (const row of callbackRows.slice(0, CUTOVER_EXPORT_MAX.callbacks)) {
    if (row.state !== 'open' && row.state !== 'done' && row.state !== 'cancelled') continue;
    callbacks.push({ firmId: row.account_id, dueOn: row.due_on, note: row.note, state: row.state,
      sourceCommandId: row.source_command_id, promisedAt: row.created_at });
  }
  const tombstoneRows = raw.prepare('SELECT account_id, observed_at, source, evidence_ref FROM pm_account_suppression_tombstones ORDER BY account_id, observed_at')
    .all() as TombstoneRow[];
  const neverCall: CutoverNeverCall[] = tombstoneRows.slice(0, CUTOVER_EXPORT_MAX.neverCall).map(row => ({
    firmId: row.account_id, observedAt: row.observed_at, source: row.source.slice(0, 80), evidenceRef: row.evidence_ref.slice(0, 200) }));
  // Only a body that differs from its seed travels: an unedited template is the seed, and the copy already has it.
  const templateRows = raw.prepare('SELECT id, subject, body, revision, updated_at FROM email_templates ORDER BY id').all() as TemplateRow[];
  const templates: CutoverTemplate[] = [];
  for (const row of templateRows) {
    if (!REPLY_TEMPLATE_IDS.some(id => id === row.id)) continue;
    const seed = seedBodyOf(row.id);
    if (seed && seed.subject === row.subject && seed.body === row.body) continue;
    templates.push({ templateId: row.id as ReplyTemplateId, subject: row.subject, body: row.body, revision: row.revision, editedAt: row.updated_at });
  }
  const candidate = { kind: CUTOVER_EXPORT_KIND, version: CUTOVER_EXPORT_VERSION, exportedAt: input.exportedAt,
    schemaVersion, callbacks, neverCall, templates, phone: input.phone,
    counts: { callbacks: callbacks.length, neverCall: neverCall.length, templates: templates.length } };
  const parsed = cutoverExportSchema.safeParse(candidate);
  if (!parsed.success) refuse('shape');
  return parsed.data;
}

export type CutoverExportDependencies = {
  acquireLock(): boolean;
  releaseLock(): void;
  ready(): Promise<void>;
  paths(): ApplicationPaths;
  loadKey(paths: ApplicationPaths): Promise<WorkspaceKey>;
  /** The folder the file is written into. Created 0700 if it does not exist. */
  destination(): string;
  now(): string;
  /** The Mac's local phone setup proof. Absent means this Mac holds none, which is `cleared`. */
  phoneSetup?(paths: ApplicationPaths): CutoverPhone;
};

/** Injectable core. Production reaches it only through the sealed host below. */
export async function performCutoverExport(deps: CutoverExportDependencies): Promise<CutoverExportReport> {
  let locked = false; let key: WorkspaceKey | undefined; let raw: RawDatabase | undefined;
  try {
    // A lock this process cannot take means the app is open, which means another process holds the database.
    locked = deps.acquireLock(); if (!locked) refuse('lock');
    await deps.ready();
    const paths = deps.paths();
    try { if (!lstatSync(paths.databasePath).isFile()) refuse('paths'); }
    catch { refuse('paths'); }
    try { key = await deps.loadKey(paths); } catch { refuse('key'); }
    const phone = (deps.phoneSetup ?? defaultPhoneSetup)(paths);
    let file: CutoverExport;
    try {
      raw = createRawDatabase(paths.databasePath, { readonly: true, fileMustExist: true });
      applyWorkspaceKey(raw, key!.bytes);
      if (raw.readonly !== true) refuse('read');
      file = readCutoverExport(raw, { exportedAt: deps.now(), phone });
    } catch (error) {
      if (error instanceof CutoverExportRefusedError) throw error;
      refuse('read');
    }
    return writeCutoverExportFile(deps.destination(), file!);
  } finally {
    key?.bytes.fill(0);
    try { raw?.close(); } catch { /* The file is already written or already refused; a close never changes either. */ }
    if (locked) deps.releaseLock();
  }
}

/** The Mac's own phone setup proof, read through the same settings object the dialer uses. Never the proof itself. */
function defaultPhoneSetup(paths: ApplicationPaths): CutoverPhone {
  const proof = new PhoneRouteSettings(join(paths.userDataPath, 'phone-route.json')).read();
  if (!proof) return { status: 'cleared', confirmedAt: null, proofDigest: null };
  return { status: 'confirmed', confirmedAt: proof.confirmedAt,
    proofDigest: createHash('sha256').update(proof.fingerprint).digest('hex') };
}

/**
 * Writes the file 0600 into a 0700 folder, never over an existing one, and fsyncs both before reporting success.
 * A second export on the same day is refused rather than silently replacing the first: the file is evidence.
 */
export function writeCutoverExportFile(directory: string, file: CutoverExport): CutoverExportReport {
  const text = `${JSON.stringify(file, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  const path = join(directory, cutoverExportFileName(file.exportedAt.slice(0, 10)));
  let handle: number | undefined; let folder: number | undefined;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    handle = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(handle, bytes);
    fsyncSync(handle);
    folder = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fsyncSync(folder);
  } catch { refuse('write'); }
  finally {
    if (handle !== undefined) try { closeSync(handle); } catch { /* The bytes are already fsynced. */ }
    if (folder !== undefined) try { closeSync(folder); } catch { /* The directory entry is already fsynced. */ }
  }
  return { kind: 'cutover_export', path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    counts: file.counts, schemaVersion: file.schemaVersion, phone: file.phone.status };
}

type PackagedHost = Pick<Electron.App, 'isPackaged' | 'getName' | 'getAppPath' | 'getPath' | 'requestSingleInstanceLock' | 'releaseSingleInstanceLock' | 'whenReady' | 'setActivationPolicy'>;

/** The sealed packaged host: the same shape the startup diagnose uses, as the second reserved mode of the old app. */
export async function runCutoverExportHost(app: PackagedHost, safeStorage: AsyncSafeStorage): Promise<CutoverExportReport> {
  validateCutoverExportInvocation(process.argv.slice(1), process.env);
  const home = userInfo().homedir;
  if (process.platform !== 'darwin' || !app.isPackaged || app.getName() !== PRODUCT
    || process.env.HOME !== home || app.getAppPath() !== join(process.resourcesPath, 'app.asar')) refuse('host');
  app.setActivationPolicy('prohibited');
  const store = new WorkspaceKeyStore({ keyProtector: new SafeStorageKeyProtector(safeStorage) });
  return performCutoverExport({
    acquireLock: () => app.requestSingleInstanceLock(), releaseLock: () => app.releaseSingleInstanceLock(),
    ready: async () => { await app.whenReady(); },
    paths: () => {
      const expected = join(home, 'Library/Application Support', PRODUCT);
      if (app.getPath('userData') !== expected) refuse('paths');
      return resolveApplicationPaths(expected);
    },
    loadKey: paths => store.loadOrCreate({ envelopePath: paths.keyEnvelopePath, databaseExists: true }),
    destination: () => join(homedir(), CUTOVER_EXPORT_DIRECTORY_NAME),
    now: () => new Date().toISOString(),
  });
}
