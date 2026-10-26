import { beforeEach } from 'vitest';
import { registerOpeningDatabases } from './campaignOpeningPgRuntime.ts';
/** Covers the unchanged shared catalog owner's database before each new case. */
beforeEach(registerOpeningDatabases);
