import {defineConfig} from 'vitest/config';
import api from '../../../apps/api/vitest.config.ts';
export default defineConfig({...api,test:{pool:'forks',globalSetup:[new URL('../../../packages/domain/db/testing/globalSetup.ts',import.meta.url).pathname],include:[new URL('./captured-support-replay.test.ts',import.meta.url).pathname],testTimeout:30000,hookTimeout:60000}});
