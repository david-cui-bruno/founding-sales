import {operations} from '../app/bridges.ts';
import type {ManualWorkPorts} from './ManualWork.tsx';
function api(){const bridge=operations();if(bridge===undefined)throw new Error('unavailable');return bridge;}
export const manualWorkPorts:ManualWorkPorts={actionRead:async input=>await api().read('ask.actionRead',input),actionChange:async input=>await api().command('ask.actionChange',input)};
