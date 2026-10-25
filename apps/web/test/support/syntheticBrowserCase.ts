import type { SyntheticCase } from './syntheticBusinessFixture.ts';

// Verbatim case A input from issue751's accepted corpus.json. No expected/oracle fields.
export const syntheticBrowserCase: SyntheticCase = {
  id: 'A', title: 'Interested, not committed', firm: 'Marshlight Property Services (invented)',
  participants: [
    { name: 'Dana Vale', email: 'dana.vale@marshlight.example.com', role: 'property manager' },
    { name: 'Evan Alder', email: 'evan.alder@example.com', role: 'founder/seller' },
  ],
  messages: [
    { id: 'SYN-A-01', direction: 'outbound', from: 'evan.alder@example.com', to: ['dana.vale@marshlight.example.com'], sentAt: '2026-10-19T14:10:00Z', subject: '[SYNTHETIC DEMO] Marshlight maintenance follow-through', body: 'Hi Dana, I am exploring how small property-management teams track maintenance requests after the first resident report. Would a short comparison of your current workflow be useful? This is not a promise of savings or a product capability claim. Evan' },
    { id: 'SYN-A-02', direction: 'inbound', from: 'dana.vale@marshlight.example.com', to: ['evan.alder@example.com'], sentAt: '2026-10-20T15:35:00Z', subject: '[SYNTHETIC DEMO] Re: Marshlight maintenance follow-through', body: 'Hi Evan, we manage roughly 184 residential units across nine buildings. Requests start in a portal, but the handoff to our outside vendors still happens by text and I chase completion in a spreadsheet. I would look at a simple way to see what is waiting on whom. I am not ready to switch systems. Dana' },
    { id: 'SYN-A-03', direction: 'outbound', from: 'evan.alder@example.com', to: ['dana.vale@marshlight.example.com'], sentAt: '2026-10-21T13:20:00Z', subject: '[SYNTHETIC DEMO] Re: Marshlight maintenance follow-through', body: 'Thanks Dana. To avoid assuming the wrong problem: is the difficult part getting vendors to acknowledge a job, confirming completion, or keeping residents updated? If helpful, we could walk through one recent request next week, without discussing a system change. Evan' },
    { id: 'SYN-A-04', direction: 'inbound', from: 'dana.vale@marshlight.example.com', to: ['evan.alder@example.com'], sentAt: '2026-10-22T16:05:00Z', subject: '[SYNTHETIC DEMO] Re: Marshlight maintenance follow-through', body: 'Completion is the messy bit. A vendor says done by text, then the resident reports the leak is still there. I can probably spare 20 minutes next week, but I need to check the inspection schedule first. Please send two possible times and a short outline. No need to involve my regional director yet. Dana' },
  ],
};
export const scriptedReply = 'Thanks Dana. We can focus the outline on one recent request, how completion was reported, and what happened when the resident said the leak remained. Please confirm your inspection schedule before we settle on a time. The regional director need not be included at this stage.';
