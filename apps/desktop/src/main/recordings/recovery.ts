import { randomUUID } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { recordingRecoveryUrlSchema, recordingRecoveryCompleteSchema } from '@fss/contracts';
import type { AuthedClient } from '../authedClient.ts';
import type { RecordingFs, RecordingUploader } from './files.ts';
import type { RecordingRecoveryView } from '../../shared/recordings.ts';

interface RecoveryDeps {
  api: AuthedClient;
  fs: Pick<RecordingFs, 'realPath' | 'statFile' | 'sniff' | 'sha256'>;
  uploader: RecordingUploader;
  recordingId: string;
  identity(): Promise<string | null>;
  expectedIdentity: string;
  signal: AbortSignal;
  root: string;
  sources: readonly { path: string; sha256: string | null }[];
  chooseFile?: () => Promise<string | null>;
}
class Unavailable extends Error {}
class AlreadyReady extends Error {}
/** Runs outside the import writer queue; it writes no local state or filesystem paths. */
export async function recoverMeetingRecording(deps: RecoveryDeps): Promise<RecordingRecoveryView> {
  const commandId = randomUUID();
  const alive = async () => { if (deps.signal.aborted || await deps.identity() !== deps.expectedIdentity || deps.signal.aborted) throw new Unavailable(); };
  const authorize = async () => {
    await alive();
    const answer = await deps.api.command('/meetings/recordings/recovery-url', { recordingId: deps.recordingId }, body => recordingRecoveryUrlSchema.parse(body), { commandId });
    await alive();
    if (!answer.ok) throw new Unavailable();
    if (answer.value.status === 'ready') throw new AlreadyReady();
    return answer.value;
  };
  try {
    const source = await authorize(); // Authority precedes any local stat, hash, or picker.
    let path: string | null = null;
    if (deps.chooseFile !== undefined) {
      path = await deps.chooseFile(); await alive();
      if (path === null) return { status: 'cancelled' };
    } else {
      const known = deps.sources.find(file => file.sha256 === source.sha256);
      if (known === undefined || deps.fs.realPath === undefined) return { status: 'choose_file' };
      const root = await deps.fs.realPath(deps.root);
      await authorize();
      path = await deps.fs.realPath(known.path);
      if (root === null || path === null) return { status: 'choose_file' };
      const within = relative(root, path);
      if (within === '' || within === '..' || within.startsWith('../') || isAbsolute(within)) return { status: 'choose_file' };
    }
    await authorize(); const before = await deps.fs.statFile(path);
    if (before === null) return { status: 'choose_file' };
    if (before.sizeBytes !== source.sizeBytes) return { status: 'wrong_file' };
    await authorize(); if (await deps.fs.sniff(path) !== 'audio') return { status: 'wrong_file' };
    await authorize(); const digest = await deps.fs.sha256(path); await alive();
    if (digest !== source.sha256) return { status: 'wrong_file' };
    await authorize(); const after = await deps.fs.statFile(path);
    if (after === null || after.sizeBytes !== before.sizeBytes || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) return { status: 'wrong_file' };
    const current = await authorize();
    if (current.sha256 !== digest || current.sizeBytes !== before.sizeBytes || current.upload.status !== 'upload') return { status: 'unavailable' };
    const put = await deps.uploader.put(current.upload.url, current.upload.headers, path, deps.signal);
    await alive(); if (!put.ok) return { status: 'upload_failed' };
    await authorize();
    const complete = await deps.api.command('/meetings/recordings/recovery-complete', { recordingId: deps.recordingId }, body => recordingRecoveryCompleteSchema.parse(body));
    await alive();
    return complete.ok ? complete.value : { status: 'unavailable' };
  } catch (error) {
    return { status: error instanceof AlreadyReady ? 'already_ready' : 'unavailable' };
  }
}
