import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
export default defineConfig({resolve:{alias:{'@fss/contracts':fileURLToPath(new URL('../contracts/src/index.ts',import.meta.url))}},test:{pool:'forks',maxWorkers:1,fileParallelism:false,include:['test/sourcing/automaticResearchProof.test.ts','test/sourcing/automaticResearchPublication.test.ts','test/sourcing/nationwideContinuity*.test.ts'],exclude:['**/*.pg.test.ts']}});
