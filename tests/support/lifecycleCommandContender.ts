import { writeFileSync } from 'node:fs';

import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import type { CompleteCurrentActionInput } from '../../src/main/domain/lifecycle/lifecycleTransactionWriter';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';

type Input = Readonly<{
  databasePath: string;
  keyHex: string;
  readyPath: string;
  ids: readonly string[];
  timestamp: string;
  command: CompleteCurrentActionInput;
}>;

const input = JSON.parse(process.argv[2] ?? '') as Input;
const database = openDatabase({
  path: input.databasePath,
  key: { bytes: Buffer.from(input.keyHex, 'hex'), version: 1 },
});
try {
  const unitOfWork = new DomainUnitOfWork(database);
  const remaining = [...input.ids];
  const clock = { now: () => input.timestamp };
  const ids = { next: () => {
    const id = remaining.shift();
    if (id === undefined) throw new Error('Lifecycle contender ID sequence exhausted.');
    return id;
  } };
  const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
  const events = new EventRepository({ database, unitOfWork, clock, ids });
  const sources = new SourceRepository({ database, unitOfWork, clock });
  const cadences = new CadenceRepository({ database, unitOfWork, clock });
  const service = new LifecycleService({
    database, unitOfWork, identities, events, sources, cadences, clock, ids,
    timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
  });
  unitOfWork.immediate(() => {
    writeFileSync(input.readyPath, 'locked', { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    service.scopedWriter().completeCurrentAction(input.command);
  });
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  closeDatabase(database);
}
