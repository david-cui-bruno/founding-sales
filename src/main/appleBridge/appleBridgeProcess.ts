import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

import {
  verifyHelperSignature,
  type HelperSignature,
  type VerifyHelperSignatureOptions,
} from './verifyHelperSignature';

export const APPLE_BRIDGE_MAX_FRAME_BYTES = 262_144;
export const APPLE_BRIDGE_MAX_STDERR_BYTES = 32 * 1_024;

const CHILD_ENV = {
  LANG: 'en_US.UTF-8',
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
} as const;
const MAX_PENDING_STDERR_LINE_BYTES = 4_096;

export type AppleBridgeChildProcess = {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type AppleBridgeSpawnOptions = {
  shell: false;
  windowsHide: true;
  stdio: readonly ['pipe', 'pipe', 'pipe'];
  env: typeof CHILD_ENV;
};

export type AppleBridgeSpawn = (
  executablePath: string,
  args: readonly string[],
  options: AppleBridgeSpawnOptions,
) => AppleBridgeChildProcess;

export type AppleBridgeProcessEvent =
  | { type: 'frame'; frame: unknown }
  | { type: 'failure'; error: Error }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null };

export type AppleBridgeTransport = {
  subscribe(listener: (event: AppleBridgeProcessEvent) => void): () => void;
  writeFrame(frame: unknown): void;
  closeInput(): void;
  terminate(): void;
};

export const spawnAppleBridge = (
  executablePath: string,
  stagingRoot: string,
  spawnProcess: AppleBridgeSpawn = nodeSpawn as unknown as AppleBridgeSpawn,
): AppleBridgeChildProcess => spawnProcess(
  executablePath,
  ['--staging-root', stagingRoot],
  {
    env: CHILD_ENV,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  },
);

export type LaunchAppleBridgeProcessOptions = Omit<
  VerifyHelperSignatureOptions,
  'run' | 'execFile'
> & {
  stagingRoot: string;
  verify?: (options: VerifyHelperSignatureOptions) => Promise<HelperSignature>;
  spawnProcess?: AppleBridgeSpawn;
};

export async function launchAppleBridgeProcess(
  options: LaunchAppleBridgeProcessOptions,
): Promise<AppleBridgeProcess> {
  const verify = options.verify ?? verifyHelperSignature;
  await verify({
    executablePath: options.executablePath,
    isPackaged: options.isPackaged,
    expectedIdentifier: options.expectedIdentifier,
    expectedTeamIdentifier: options.expectedTeamIdentifier,
    allowUnsignedDevelopment: options.allowUnsignedDevelopment,
  });
  return new AppleBridgeProcess(spawnAppleBridge(
    options.executablePath,
    options.stagingRoot,
    options.spawnProcess,
  ));
}

export class AppleBridgeProcess implements AppleBridgeTransport {
  readonly #listeners = new Set<(event: AppleBridgeProcessEvent) => void>();
  readonly #frameChunks: Buffer[] = [];
  readonly #stderrDecoder = new StringDecoder('utf8');
  #frameByteCount = 0;
  #stderr = '';
  #stderrLine = '';
  #terminal = false;
  #inputClosed = false;

  readonly #onStdoutData = (chunk: Buffer | string): void => {
    this.#consumeStdout(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  };
  readonly #onStderrData = (chunk: Buffer | string): void => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.#consumeStderr(this.#stderrDecoder.write(buffer));
  };
  readonly #onStderrEnd = (): void => {
    this.#consumeStderr(this.#stderrDecoder.end());
    this.#commitStderrLine();
  };
  readonly #onExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#emit({ type: 'exit', code, signal });
  };
  readonly #onTerminalError = (): void => {
    this.#fail(new Error('Apple bridge process transport failed.'));
  };

  constructor(readonly child: AppleBridgeChildProcess) {
    child.stdout.on('data', this.#onStdoutData);
    child.stdout.on('error', this.#onTerminalError);
    child.stderr.on('data', this.#onStderrData);
    child.stderr.on('end', this.#onStderrEnd);
    child.stderr.on('error', this.#onTerminalError);
    child.stdin.on('error', this.#onTerminalError);
    child.on('exit', this.#onExit);
    child.on('error', this.#onTerminalError);
  }

  get diagnostics(): string {
    const preview = this.#stderrLine.length > 0
      ? sanitizeDiagnostic(this.#stderrLine)
      : '';
    return appendWithinUTF8Limit(this.#stderr, preview, APPLE_BRIDGE_MAX_STDERR_BYTES);
  }

  subscribe(listener: (event: AppleBridgeProcessEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  writeFrame(frame: unknown): void {
    if (this.#terminal || this.#inputClosed) {
      throw new Error('Apple bridge process is not writable.');
    }
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8');
    if (encoded.length > APPLE_BRIDGE_MAX_FRAME_BYTES) {
      throw new Error(`Apple bridge request exceeds ${APPLE_BRIDGE_MAX_FRAME_BYTES} wire bytes.`);
    }
    this.child.stdin.write(encoded);
  }

  closeInput(): void {
    if (this.#inputClosed) return;
    this.#inputClosed = true;
    this.child.stdin.end();
  }

  terminate(): void {
    if (this.#terminal) return;
    this.child.kill('SIGTERM');
  }

  dispose(): void {
    this.child.stdout.removeListener('data', this.#onStdoutData);
    this.child.stdout.removeListener('error', this.#onTerminalError);
    this.child.stderr.removeListener('data', this.#onStderrData);
    this.child.stderr.removeListener('end', this.#onStderrEnd);
    this.child.stderr.removeListener('error', this.#onTerminalError);
    this.child.stdin.removeListener('error', this.#onTerminalError);
    this.child.removeListener('exit', this.#onExit);
    this.child.removeListener('error', this.#onTerminalError);
    this.#listeners.clear();
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#terminal) return;
    let offset = 0;
    while (offset < chunk.length && !this.#terminal) {
      const newline = chunk.indexOf(0x0A, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segmentLength = end - offset;
      const prospectiveWireBytes = this.#frameByteCount
        + segmentLength
        + (newline === -1 ? 1 : 1);
      if (prospectiveWireBytes > APPLE_BRIDGE_MAX_FRAME_BYTES) {
        this.#fail(new Error(
          `Apple bridge protocol frame exceeds ${APPLE_BRIDGE_MAX_FRAME_BYTES} wire bytes.`,
        ));
        return;
      }
      if (segmentLength > 0) {
        const segment = chunk.subarray(offset, end);
        this.#frameChunks.push(segment);
        this.#frameByteCount += segment.length;
      }
      if (newline === -1) return;

      const frameBytes = this.#frameChunks.length === 1
        ? this.#frameChunks[0]
        : Buffer.concat(this.#frameChunks, this.#frameByteCount);
      this.#frameChunks.length = 0;
      this.#frameByteCount = 0;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(frameBytes);
        const frame: unknown = JSON.parse(text);
        this.#emit({ type: 'frame', frame });
      } catch {
        this.#fail(new Error('Apple bridge emitted a malformed JSONL protocol frame.'));
        return;
      }
      offset = newline + 1;
    }
  }

  #consumeStderr(text: string): void {
    for (const character of text) {
      if (character === '\n' || character === '\r') {
        this.#commitStderrLine(character);
        continue;
      }
      this.#stderrLine += character;
      if (Buffer.byteLength(this.#stderrLine, 'utf8') > MAX_PENDING_STDERR_LINE_BYTES) {
        this.#appendDiagnostic('[redacted-line]');
        this.#stderrLine = '';
      }
    }
  }

  #commitStderrLine(separator = ''): void {
    if (this.#stderrLine.length > 0) {
      this.#appendDiagnostic(sanitizeDiagnostic(this.#stderrLine));
      this.#stderrLine = '';
    }
    if (separator.length > 0) this.#appendDiagnostic(separator);
  }

  #appendDiagnostic(value: string): void {
    this.#stderr = appendWithinUTF8Limit(
      this.#stderr,
      value,
      APPLE_BRIDGE_MAX_STDERR_BYTES,
    );
  }

  #fail(error: Error): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.child.stdout.removeListener('data', this.#onStdoutData);
    try {
      this.child.kill('SIGTERM');
    } catch {
      // The protocol failure remains authoritative even if termination races exit.
    }
    this.#emit({ type: 'failure', error });
  }

  #emit(event: AppleBridgeProcessEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[email]')
    .replace(/\/(?:[^\s"'<>/]+\/)*[^\s"'<>]*/gu, '[path]')
    .replace(/\+?\d[\d().\-\s]{5,}\d/gu, '[phone]');
}

function appendWithinUTF8Limit(current: string, addition: string, limit: number): string {
  let remaining = limit - Buffer.byteLength(current, 'utf8');
  if (remaining <= 0 || addition.length === 0) return current;
  let accepted = '';
  for (const character of addition) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (bytes > remaining) break;
    accepted += character;
    remaining -= bytes;
  }
  return current + accepted;
}
