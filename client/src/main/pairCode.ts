import { readFile, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * The Pair page takes either the code itself or the absolute path of the private file the operator tool
 * wrote it to (`--output /private/dir/file`, one line). A code is 32 random bytes in base64url, 43
 * characters; nothing else is accepted, and a file that holds anything else is refused without a redeem.
 */
export const PAIR_CODE = /^[A-Za-z0-9_-]{43}$/;
const MAX_CODE_FILE_BYTES = 4096;

export type PairCodeRefusal = 'code_invalid' | 'code_file_unreadable' | 'code_file_invalid';
export class PairCodeError extends Error {
  constructor(readonly reason: PairCodeRefusal) {
    super(reason);
    this.name = 'PairCodeError';
  }
}

export type ResolvedPairCode = { code: string; codeFile: string | null };

export async function resolvePairCode(input: string): Promise<ResolvedPairCode> {
  const trimmed = input.trim();
  if (PAIR_CODE.test(trimmed)) return { code: trimmed, codeFile: null };
  if (!isAbsolute(trimmed)) throw new PairCodeError('code_invalid');
  let text: string;
  try {
    const bytes = await readFile(trimmed);
    if (bytes.length > MAX_CODE_FILE_BYTES) throw new PairCodeError('code_file_invalid');
    text = bytes.toString('utf8');
  } catch (error) {
    if (error instanceof PairCodeError) throw error;
    throw new PairCodeError('code_file_unreadable');
  }
  const code = text.trim();
  if (!PAIR_CODE.test(code)) throw new PairCodeError('code_file_invalid');
  return { code, codeFile: trimmed };
}

/** Deletes the code file after a successful redeem; true when this call removed it. */
export async function deleteCodeFile(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}
