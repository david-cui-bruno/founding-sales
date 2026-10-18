import { operations } from "../app/bridges.ts";
import type { EmailTimelinePorts } from "./EmailTimeline.tsx";

function api() {
  const value = operations();
  if (value === undefined) throw new Error("unavailable");
  return value;
}

export const emailTimelinePorts: EmailTimelinePorts = {
  list: async (input) => api().read("crm.businessMailList", input),
  read: async (input) => api().read("crm.businessMailRead", input),
  readV2: async (input) => api().read("crm.businessMailReadV2", input),
  controls: async (input) => api().read("crm.businessMailControls", input),
  state: async (input) => api().read("crm.businessMailState", input),
  remove: async (input) => api().command("crm.businessMailDelete", input),
  restore: async (input) => api().command("crm.businessMailRestore", input),
  recapture: async (input) => api().command("crm.businessMailRecapture", input),
  associate: async (input) => api().command("crm.businessMailAssociate", input),
  choices: async () => {
    const [people, firms] = await Promise.all([
      api().read("crm.personList", { limit: 50 }),
      api().read("crm.relationshipFirms", {}),
    ]);
    return {
      people: people.people.map((person) => ({
        id: person.personId,
        name: person.fullName,
      })),
      firms: firms.firms.map((firm) => ({ id: firm.id, name: firm.name })),
    };
  },
};
