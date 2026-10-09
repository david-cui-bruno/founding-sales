import { operations } from '../app/bridges.ts';
import type { BusinessReviewPorts } from './BusinessReview.tsx';
function api() { const value = operations(); if (value === undefined)
  throw new Error('unavailable'); return value; }
export const businessReviewPorts: BusinessReviewPorts = { imports:{health:async input=>api().read('crm.businessMailImportHealth',input),request:async input=>api().command('crm.businessMailImportRequest',input)}, policy: async () => api().read('crm.businessPolicyRead', {}), savePolicy: async (input) => api().command('crm.businessPolicySave', input), review: async (mailboxId, after) => api().read('crm.businessReviewRead', { mailboxId, limit: 50, ...(after === undefined ? {} : { after }) }), decide: async (input) => api().command('crm.businessReviewDecide', input) };
