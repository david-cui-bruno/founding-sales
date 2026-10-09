import type {ProcessingPorts} from './ProcessingHealth.tsx';
import type { ContextPorts } from "./SourceContexts.tsx";
import type { EndpointPorts, EndpointEditingPorts } from "./Endpoints.tsx";
import type { FirmAddressPorts } from "./FirmAddresses.tsx";
import type {
  RelationshipPorts,
  RelationshipEditingPorts,
} from "./Relationships.tsx";
import { operations } from "../app/bridges.ts";
import type { PeoplePorts } from "./People.tsx";
function api() {
  const value = operations();
  if (value === undefined) throw new Error("unavailable");
  return value;
}
export const peoplePorts: PeoplePorts = {
  list: async (afterId) =>
    await api().read(
      "crm.personList",
      afterId === undefined ? { limit: 50 } : { afterId, limit: 50 },
    ),
  read: async (personId, afterSourceId) =>
    await api().read("crm.personRead", {
      personId,
      limit: 50,
      ...(afterSourceId === undefined ? {} : { afterSourceId }),
    }),
  create: async (fullName) =>
    await api().command("crm.personCreate", { fullName }),
  add: async (input) => await api().command("crm.personSourceAdd", input),
  remove: async (input) => {
    await api().command("crm.personSourceDelete", input);
  },
  recapture: async (input) => {
    await api().command("crm.personSourceRecapture", input);
  },
  restore: async (input) => {
    await api().command("crm.personSourceRestore", input);
  },
};

export const relationshipPorts: RelationshipPorts = {
  read: async (personId, afterId) =>
    await api().read("crm.relationshipRead", {
      personId,
      limit: 50,
      ...(afterId === undefined ? {} : { afterId }),
    }),
};

export const relationshipEditingPorts: RelationshipEditingPorts = {
  firms: async () => {
    const result = await api().read("crm.relationshipFirms", {});
    return result.firms.map((firm) => ({ firmId: firm.id, name: firm.name }));
  },
  save: async (input) => {
    await api().command("crm.relationshipSave", input);
  },
  correct: async (input) => {
    await api().command("crm.relationshipCorrect", input);
  },
};

export const endpointPorts: EndpointPorts = {
  list: async (input) =>
    await api().read("crm.endpointList", { ...input, limit: 50 }),
  match: async (input) => await api().read("crm.endpointMatch", input),
};
export const endpointEditingPorts: EndpointEditingPorts = {
  owners: async () => {
    const [people, firms] = await Promise.all([
      peoplePorts.list(),
      relationshipEditingPorts.firms(),
    ]);
    return [
      ...people.people.map((person) => ({
        kind: "person" as const,
        id: person.personId,
        name: person.fullName,
      })),
      ...firms.map((firm) => ({
        kind: "firm" as const,
        id: firm.firmId,
        name: firm.name,
      })),
    ];
  },
  claim: async (input) => {
    await api().command("crm.endpointClaim", input);
  },
  correct: async (input) => {
    await api().command("crm.endpointCorrect", input);
  },
};
export const firmAddressPorts: FirmAddressPorts = {
  firms: async () => await relationshipEditingPorts.firms(),
  read: async (firmId, afterSourceId) =>
    await api().read("crm.firmSourceRead", {
      firmId,
      limit: 50,
      ...(afterSourceId === undefined ? {} : { afterSourceId }),
    }),
  add: async (input) => {
    await api().command("crm.firmSourceAdd", input);
  },
  remove: async (input) => {
    await api().command("crm.firmSourceDelete", input);
  },
  restore: async (input) => {
    await api().command("crm.firmSourceRestore", input);
  },
  recapture: async (input) => {
    await api().command("crm.firmSourceRecapture", input);
  },
};

export const sourceContextPorts: ContextPorts = {
  read: async (personId, afterId) =>
    await api().read("crm.sourceContextRead", {
      personId,
      limit: 50,
      ...(afterId === undefined ? {} : { afterId }),
    }),
  save: async (input) => {
    await api().command("crm.sourceContextSave", input);
  },
};

export const processingPorts:ProcessingPorts={health:async input=>await api().read("crm.processingHealth",input),request:async source=>{await api().command("crm.processingRequest",{source});}};
