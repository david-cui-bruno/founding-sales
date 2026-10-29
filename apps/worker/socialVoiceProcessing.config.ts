import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
import source from './vitest.config.ts';
/** Changed processing-scope checks only. No PG, provider loader or globalSetup. */
export default defineConfig({...source,root:fileURLToPath(new URL('../../',import.meta.url)),test:{pool:'forks',maxWorkers:1,fileParallelism:false,
 include:['apps/worker/test/socialVoiceProcessing.test.ts','apps/worker/test/socialDraftModel.test.ts','packages/domain/test/social/voiceProcessingScope.test.ts',
 'packages/domain/test/social/voiceGeneration.test.ts','packages/contracts/test/socialVoiceGeneration.test.ts','apps/web/test/client/socialGuidedGeneration.test.tsx']}});
