import { operations } from '../app/bridges.ts';
import type { PeoplePorts } from './People.tsx';
function api() {
  const value = operations();
  if (value === undefined) throw new Error('unavailable');
  return value;
}
export const peoplePorts: PeoplePorts = {
  list: async (afterId) =>
    await api().read(
      'crm.personList',
      afterId === undefined ? { limit: 50 } : { afterId, limit: 50 },
    ),
  read: async (personId, afterSourceId) =>
    await api().read('crm.personRead', {
      personId,
      limit: 50,
      ...(afterSourceId === undefined ? {} : { afterSourceId }),
    }),
  create: async (fullName) =>
    await api().command('crm.personCreate', { fullName }),
  add: async (input) => await api().command('crm.personSourceAdd', input),
  remove: async (input) => {
    await api().command('crm.personSourceDelete', input);
  },
  recapture: async (input) => {
    await api().command('crm.personSourceRecapture', input);
  },
  restore: async (input) => {
    await api().command('crm.personSourceRestore', input);
  },
};
