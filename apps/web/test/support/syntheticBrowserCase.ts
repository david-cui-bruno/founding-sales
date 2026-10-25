import type { SyntheticCase } from './syntheticBusinessFixture.ts';

// Verbatim case A input from issue751's accepted corpus.json. No expected/oracle fields.
export const syntheticBrowserCase: SyntheticCase = {
  id: 'A', title: 'SYNTHETIC DEMO: interested property manager clarifies demo and follow-up', firm: 'Fablewick Property Stewardship (invented)',
  participants: [
    { name: 'Mara Fenwick (invented)', email: 'mara.fenwick@example.com', role: 'property manager' },
    { name: 'Evan Alder (invented)', email: 'evan.alder@example.com', role: 'demo coordinator' },
  ],
  messages: [
    { id: 'SYN-A-01', direction: 'inbound', from: 'mara.fenwick@example.com', to: ['evan.alder@example.com'], sentAt: '2026-10-23T09:10:00-04:00', subject: '[SYNTHETIC DEMO] Maintenance coordination walkthrough', body: 'Our team coordinates maintenance for 84 rental doors. I am interested in seeing how a walkthrough would address incoming repair requests and handoffs to vendors. By demo, do you mean a live repair dispatch or a screen walkthrough? All times in this thread use America/New_York (EDT, UTC-04:00).' },
    { id: 'SYN-A-02', direction: 'outbound', from: 'evan.alder@example.com', to: ['mara.fenwick@example.com'], sentAt: '2026-10-23T10:00:00-04:00', subject: '[SYNTHETIC DEMO] Re: Maintenance coordination walkthrough', body: 'I mean a 20-minute screen walkthrough using fictional maintenance requests, not a live repair dispatch or a claim of results. We can focus on intake, assigning a responsible person, and vendor handoff questions. Would 2026-10-26 at 14:00 America/New_York (EDT, UTC-04:00) work?' },
    { id: 'SYN-A-03', direction: 'inbound', from: 'mara.fenwick@example.com', to: ['evan.alder@example.com'], sentAt: '2026-10-23T10:25:00-04:00', subject: '[SYNTHETIC DEMO] Re: Maintenance coordination walkthrough', body: 'Yes, the screen walkthrough is what I want. I agree to 2026-10-26, 14:00-14:20 America/New_York (EDT, UTC-04:00). Please keep the discussion on who owns a request when a vendor has not replied. I will attend alone.' },
    { id: 'SYN-A-04', direction: 'outbound', from: 'evan.alder@example.com', to: ['mara.fenwick@example.com'], sentAt: '2026-10-23T10:40:00-04:00', subject: '[SYNTHETIC DEMO] Re: Maintenance coordination walkthrough', body: 'The agreed fixture time is 2026-10-26, 14:00-14:20 America/New_York (EDT, UTC-04:00), focused on unanswered vendor handoffs for your 84 doors. I will email a one-page recap of your open questions and proposed next steps by 2026-10-27 at 12:00 America/New_York (EDT, UTC-04:00). This invented fixture contains no calendar invitation or actual booking operation.' },
  ],
};
export const syntheticReplySource = syntheticBrowserCase.messages.filter(source => source.direction === 'inbound').at(-1)!;
export const scriptedReply = 'Thank you for clarifying. The screen walkthrough focuses on request ownership when vendors have not replied, using fictional maintenance requests. The agreed fixture time is 2026-10-26, 14:00-14:20 America/New_York. The one-page recap is due 2026-10-27 at 12:00 America/New_York. No real booking or send is performed in this rehearsal.';
