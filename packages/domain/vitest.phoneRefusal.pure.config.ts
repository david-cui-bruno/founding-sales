import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['test/sourcing/manualPhoneRefusalDiagnostics.test.ts','test/sourcing/manualProspectLiteralPhone.test.ts'],maxWorkers:1}});
