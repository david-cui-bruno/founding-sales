import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteCodeFile, PAIR_CODE, resolvePairCode } from './pairCode';

const freshCode = () => randomBytes(32).toString('base64url');

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'client-pair-code-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe('resolvePairCode', () => {
  it('accepts a pasted code, trimmed', async () => {
    const code = freshCode();
    expect(PAIR_CODE.test(code)).toBe(true);
    expect(await resolvePairCode(`  ${code}\n`)).toEqual({ code, codeFile: null });
  });

  it('reads the code from an absolute path to the operator output file', async () => {
    const code = freshCode();
    const path = join(directory, 'device-code');
    writeFileSync(path, `${code}\n`, { mode: 0o600 });
    expect(await resolvePairCode(path)).toEqual({ code, codeFile: path });
  });

  it('refuses a file that does not hold a code', async () => {
    const path = join(directory, 'device-code');
    writeFileSync(path, 'not a code\n');
    await expect(resolvePairCode(path)).rejects.toMatchObject({ reason: 'code_file_invalid' });
    writeFileSync(path, `${freshCode()}\n${freshCode()}\n`);
    await expect(resolvePairCode(path)).rejects.toMatchObject({ reason: 'code_file_invalid' });
  });

  it('refuses a path it cannot read', async () => {
    await expect(resolvePairCode(join(directory, 'missing'))).rejects.toMatchObject({ reason: 'code_file_unreadable' });
  });

  it('refuses anything that is neither a code nor an absolute path', async () => {
    await expect(resolvePairCode('relative/path')).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(resolvePairCode('abc')).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(resolvePairCode(`${freshCode()}!`)).rejects.toMatchObject({ reason: 'code_invalid' });
  });
});

describe('deleteCodeFile', () => {
  it('deletes the file once and reports whether it did', async () => {
    const path = join(directory, 'device-code');
    writeFileSync(path, `${freshCode()}\n`);
    expect(await deleteCodeFile(path)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(await deleteCodeFile(path)).toBe(false);
  });
});
