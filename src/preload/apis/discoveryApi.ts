import { mutationReceiptSchema } from '../../shared/contracts/commonContract';
import {
  beginDiscoveryReceiptSchema, beginDiscoveryRequestSchema, discoveryBriefRequestSchema,
  discoveryBriefSchema, discoverySnapshotSchema, overrideDiscoveryRequestSchema,
  type DiscoveryApi, type DiscoveryBriefRequest, type BeginDiscoveryRequest, type OverrideDiscoveryRequest,
} from '../../shared/contracts/discoveryContract';
import type { IpcClient } from '../ipcClient';

/** Discovery uses the same strict client as the other workflow namespaces. */
export const createDiscoveryApi = (client: IpcClient): DiscoveryApi => ({
  get: async (...args: []) => {
    if (args.length !== 0) throw new Error('Discovery get accepts no arguments.');
    const snapshot = await client.requestNoInput('discovery:get', discoverySnapshotSchema);
    const ids = [...snapshot.prepared, ...snapshot.judgment].map(brief => brief.personId);
    if (new Set(ids).size !== ids.length) throw new Error('Discovery snapshot contains duplicate Persons.');
    return snapshot;
  },
  getBrief: async (...args: [DiscoveryBriefRequest]) => {
    if (args.length !== 1) throw new Error('Discovery brief requires one request.');
    const input = discoveryBriefRequestSchema.parse(args[0]);
    const brief = await client.request('discovery:get-brief', discoveryBriefRequestSchema, discoveryBriefSchema, input);
    if (brief.personId !== input.personId) throw new Error('Discovery brief does not match the request.');
    return brief;
  },
  begin: async (...args: [BeginDiscoveryRequest]) => {
    if (args.length !== 1) throw new Error('Discovery begin requires one request.');
    // Keep parsed identity independent of caller mutations during the request.
    const input = beginDiscoveryRequestSchema.parse(args[0]);
    const receipt = await client.request('discovery:begin', beginDiscoveryRequestSchema, beginDiscoveryReceiptSchema, input);
    if (receipt.personId !== input.personId || receipt.salesCycleId !== input.salesCycleId
      || receipt.assessmentId !== input.assessmentId) throw new Error('Discovery receipt does not match the request.');
    return receipt;
  },
  override: async (...args: [OverrideDiscoveryRequest]) => {
    if (args.length !== 1) throw new Error('Discovery override requires one request.');
    const input = overrideDiscoveryRequestSchema.parse(args[0]);
    const receipt = await client.request('discovery:override', overrideDiscoveryRequestSchema, mutationReceiptSchema, input);
    if (!receipt.affectedPersonIds.includes(input.personId)) throw new Error('Discovery override does not match the request.');
    return receipt;
  },
});
