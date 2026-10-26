import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
/** Local pure policy/fake-port checks only. No database, network or globalSetup. */
export default defineConfig({resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../contracts/src/index.ts',import.meta.url))}},test:{include:['test/social/voiceGeneration.test.ts'],pool:'forks'}});
