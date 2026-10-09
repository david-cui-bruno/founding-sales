import {operations} from '../app/bridges.ts';
import type {PromiseActionPorts} from './ActionQueue.tsx';
function api(){const value=operations();if(value===undefined)throw new Error('unavailable');return value;}
export const promiseActionPorts:PromiseActionPorts={
 read:async input=>await api().read('crm.commitmentsRead',input),
 complete:async input=>await api().command('crm.commitmentsComplete',input),
};
