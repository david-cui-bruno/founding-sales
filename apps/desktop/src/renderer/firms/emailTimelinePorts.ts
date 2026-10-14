import { operations } from "../app/bridges.ts";
import type { EmailTimelinePorts } from "./EmailTimeline.tsx";

function api() {
  const value = operations();
  if (value === undefined) throw new Error("unavailable");
  return value;
}

export const emailTimelinePorts: EmailTimelinePorts = {
  bookingConversation:{
    policy:async()=>{const result=await api().read('meetings.bookingPolicy',{});return result.view?{revision:result.view.policy.revision,status:result.view.policy.setting.status}:null;},
    request:async input=>api().command('meetings.bookingConversationRequest',input),
    read:async input=>api().read('meetings.bookingConversationRead',input),
    event:async input=>api().command('meetings.bookingConversationEvent',input),
    messageRequest:async input=>api().command('meetings.bookingMessageRequest',input),
    messageRead:async input=>api().read('meetings.bookingMessageRead',input),
  },
  booking:{request:async input=>api().command('crm.bookingInterpretationRequest',input),read:async input=>api().read('crm.bookingInterpretationRead',input)},
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
