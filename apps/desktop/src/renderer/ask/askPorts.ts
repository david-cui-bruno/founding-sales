import {manualWorkPorts} from './manualWorkPorts.ts';
import { operations } from '../app/bridges.ts';
import type { AskPorts } from './Ask.tsx';
export const askPorts: AskPorts = {
  ...manualWorkPorts,
  read: async (input) => {
    const bridge = operations();
    if (bridge === undefined) throw new Error('unavailable');
    return await bridge.read('ask.read', input);
  },
};
