import { operations } from '../app/bridges.ts';
import type { BusinessReviewPorts } from './BusinessReview.tsx';
function api() { const value = operations(); if (value === undefined)
  throw new Error('unavailable'); return value; }
export const businessReviewPorts: BusinessReviewPorts = { policy: async () => api().read('crm.businessPolicyRead', {}), savePolicy: async (input) => api().command('crm.businessPolicySave', input), review: async (mailboxId, after) => api().read('crm.businessReviewRead', { mailboxId, limit: 50, ...(after === undefined ? {} : { after }) }), decide: async (input) => api().command('crm.businessReviewDecide', input) };
