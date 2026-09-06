import { join } from 'node:path';

export function resolveApplicationPaths(userDataPath: string) {
  return {
    userDataPath,
    databasePath: join(userDataPath, 'callie.sqlite3'),
    keyEnvelopePath: join(userDataPath, 'callie.key-envelope.json'),
    backupDirectory: join(userDataPath, 'backups'),
  };
}
export type ApplicationPaths = ReturnType<typeof resolveApplicationPaths>;
