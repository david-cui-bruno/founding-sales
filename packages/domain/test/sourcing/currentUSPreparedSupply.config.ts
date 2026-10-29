import {defineConfig} from 'vitest/config';
/** Pure current/legacy boundary checks only. Root owns actual migration/runtime acceptance. */
export default defineConfig({test:{include:['test/sourcing/currentUSPreparedSupply.test.ts','test/sourcing/currentPreparedEmailFit.test.ts','test/sourcing/nativeFirmEligibility.test.ts',
 'test/sourcing/automaticResearchProof.test.ts','test/sourcing/automaticResearchPublication.test.ts','test/sourcing/qualificationPolicy.test.ts'],
 maxWorkers:1,fileParallelism:false}});
