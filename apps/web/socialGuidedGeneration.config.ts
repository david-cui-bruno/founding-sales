import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),test:{include:['test/client/socialGuidedGeneration.test.tsx','test/server/socialGenerationBoundary.test.ts','test/client/socialReview.test.tsx','test/client/socialReviewExpiry.test.tsx'],maxWorkers:1,fileParallelism:false}});
