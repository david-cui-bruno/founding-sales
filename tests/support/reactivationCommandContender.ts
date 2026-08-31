import { existsSync, writeFileSync } from 'node:fs';

import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import type { ReactivateFromInboundInput } from '../../src/main/domain/lifecycle/lifecycleTransactionWriter';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import type { ReactivationCommandWorkerInput } from './domainWriteWorker';

const input = JSON.parse(process.argv[2] ?? '') as ReactivationCommandWorkerInput;
const database = openDatabase({
  path: input.databasePath,
  key: { bytes: Buffer.from(input.keyHex, 'hex'), version: 1 },
});
try {
  writeFileSync(input.readyPath, 'ready', { mode: 0o600 });
  waitForPath(input.startPath);
  writeFileSync(input.attemptPath, 'attempt', { mode: 0o600 });
  const unitOfWork = new DomainUnitOfWork(database);
  const remaining = [...input.ids];
  const clock = { now: () => input.timestamp };
  const ids = { next: () => {
    const id = remaining.shift();
    if (id === undefined) throw new Error('Reactivation contender ID sequence exhausted.');
    return id;
  } };
  const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
  const events = new EventRepository({ database, unitOfWork, clock, ids });
  const sources = new SourceRepository({ database, unitOfWork, clock });
  const cadences = new CadenceRepository({ database, unitOfWork, clock });
  const lifecycle = new LifecycleService({
    database, unitOfWork, identities, events, sources, cadences, clock, ids,
    timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
  });
  const command = input.command as ReactivateFromInboundInput;
  const result = input.holdLockBeforeCommand
    ? unitOfWork.immediate(() => {
        writeFileSync(input.lockedPath, 'locked', { mode: 0o600 });
        waitForPath(input.releasePath);
        return lifecycle.scopedWriter().reactivateFromInboundResponse(command);
      })
    : lifecycle.reactivateFromInboundResponse(command);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  closeDatabase(database);
}

function waitForPath(path: string): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) Atomics.wait(signal, 0, 0, 10);
}
