import { writeFileSync } from 'node:fs';

import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OptOutService } from '../../src/main/domain/optOut/optOutService';
import type { ApplyOptOutInput } from '../../src/main/domain/optOut/optOutTypes';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import type { OptOutCommandWorkerInput } from './domainWriteWorker';

const input = JSON.parse(process.argv[2] ?? '') as OptOutCommandWorkerInput;
const database = openDatabase({
  path: input.databasePath,
  key: { bytes: Buffer.from(input.keyHex, 'hex'), version: 1 },
});
try {
  const unitOfWork = new DomainUnitOfWork(database);
  const clock = { now: () => input.timestamp };
  const remaining = [...input.ids];
  const ids = { next: () => {
    const id = remaining.shift();
    if (id === undefined) throw new Error('Opt-out race worker exhausted its IDs.');
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
  const service = new OptOutService({
    database, unitOfWork, identities, events,
    optOuts: new OptOutRepository({ database, unitOfWork }),
    lifecycle, clock, ids,
    faultInjector: (point) => {
      if (point !== 'after_activity') return;
      writeFileSync(input.readyPath, 'locked', { mode: 0o600 });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    },
  });
  process.stdout.write(`${JSON.stringify(service.apply(input.command as ApplyOptOutInput))}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  closeDatabase(database);
}
