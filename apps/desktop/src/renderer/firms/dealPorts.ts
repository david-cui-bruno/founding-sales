import { operations } from '../app/bridges.ts';
import type { DealChoicePorts } from './DealChoices.tsx';
function api() {
  const value = operations();
  if (value === undefined) throw new Error('unavailable');
  return value;
}
export const dealPorts: DealChoicePorts = {
  create: async (input) => await api().command('crm.dealCreate', input),
  reopen: async (input) => await api().command('crm.dealReopen', input),
};
