import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lastGoodTodaySchema, type LastGoodToday } from '../shared/clientContract';

/**
 * The last good `/v1/today` answer, kept on disk with the instant it was fetched so a morning survives an
 * outage (FSS target design, section 1). Plain JSON: a Today view holds no secret. Written atomically after
 * every successful read; never written on a failure, so what is on disk is always a complete good answer.
 */
export const TODAY_LAST_GOOD_FILE = 'today-last-good.json';

export async function writeLastGoodToday(directory: string, record: LastGoodToday): Promise<void> {
  const value = lastGoodTodaySchema.parse(record);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, TODAY_LAST_GOOD_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch((): undefined => undefined);
    throw error;
  }
}

export async function readLastGoodToday(directory: string): Promise<LastGoodToday | null> {
  try {
    return lastGoodTodaySchema.parse(JSON.parse(await readFile(join(directory, TODAY_LAST_GOOD_FILE), 'utf8')));
  } catch {
    return null;
  }
}
