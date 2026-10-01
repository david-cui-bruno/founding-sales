/**
 * Static fixtures for the design prototype. Invented Dallas–Fort Worth property-management
 * firms: no real business, person, address or number. Phone numbers are in the NANP
 * 555-01XX fictional block and every web address is under `example.test` (RFC 6761).
 *
 * The prototype's "now" is fixed so every screenshot reads the same.
 */

export const NOW = new Date('2026-10-02T14:40:00Z'); // Thu 2 Oct, 9:40 am Central

export type QueueReason = 'callback' | 'reply' | 'prospect';
export type Stage = 'interested' | 'demo_booked' | 'decision_pending' | 'onboarding' | 'live' | 'lost';

export interface Fact {
  readonly label: string;
  readonly value: string;
  /** verified: a source says so; hypothesis: inferred, labelled as such; unknown: nobody knows yet. */
  readonly kind: 'verified' | 'hypothesis' | 'unknown';
  readonly source?: string;
}

export interface Source {
  readonly title: string;
  readonly url: string;
  readonly observed: string;
}

export interface Activity {
  readonly at: string;
  readonly kind: 'call' | 'email' | 'note' | 'meeting' | 'stage';
  readonly title: string;
  readonly detail?: string;
  readonly durationSec?: number;
  readonly summary?: readonly string[];
}

export interface Contact {
  readonly name: string;
  readonly role: string;
  readonly phone?: string;
  readonly email?: string;
  readonly primary?: boolean;
}

export interface Firm {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly timeZone: string | null;
  readonly phone: string | null;
  readonly website: string;
  readonly doors: string;
  readonly software: string;
  readonly stage: Stage | null;
  readonly owner: string;
  readonly queue?: {
    readonly reason: QueueReason;
    readonly line: string;
    readonly due?: string;
    readonly attempt?: number;
  };
  readonly whyThisFirm: string;
  readonly askFor: { readonly who: string; readonly note: string };
  readonly facts: readonly Fact[];
  readonly opening: string;
  readonly questions: readonly [string, string];
  readonly research: readonly { readonly heading: string; readonly body: string; readonly sources: readonly number[] }[];
  readonly sources: readonly Source[];
  readonly contacts: readonly Contact[];
  readonly activity: readonly Activity[];
  readonly nextActions: readonly { readonly label: string; readonly due: string; readonly done?: boolean }[];
  readonly pipeline?: {
    readonly next: string;
    readonly nextDue: string;
    readonly meeting: string | null;
    readonly meetingState: 'confirmed' | 'requested' | 'held' | 'none';
    readonly value: { readonly monthly: number; readonly kind: 'estimated' | 'agreed' } | null;
  };
}

const LONG_NAME = 'Brazos Valley Single-Family Residential Property Management & Leasing Services of North Texas, LLC';

export const FIRMS: readonly Firm[] = [
  {
    id: 'trinity-ridge',
    name: 'Trinity Ridge Property Management',
    city: 'Fort Worth',
    state: 'TX',
    timeZone: 'America/Chicago',
    phone: '(817) 555-0142',
    website: 'trinityridge.example.test',
    doors: '~420 doors',
    software: 'AppFolio',
    stage: null,
    owner: 'David',
    queue: { reason: 'callback', line: 'Callback · 10:30 am', due: '10:30 am', attempt: 2 },
    whyThisFirm:
      'Scattered-site single-family manager on AppFolio, about 420 doors across Tarrant County. On Tuesday Dana asked to be called back Thursday morning “when the maintenance coordinator is in.”',
    askFor: { who: 'Dana Whitfield, Operations Manager', note: 'She asked for the callback. Marcus (maintenance coordinator) may join.' },
    facts: [
      { label: 'Portfolio', value: 'Single-family, scattered sites', kind: 'verified', source: 'Website · Services' },
      { label: 'Doors', value: 'About 420', kind: 'verified', source: 'Website · About, observed 24 Sep' },
      { label: 'Software', value: 'AppFolio', kind: 'verified', source: 'Owner portal login page' },
      { label: 'After-hours line', value: 'Answering service, likely outsourced', kind: 'hypothesis' },
      { label: 'Maintenance staff', value: 'Unknown', kind: 'unknown' },
      { label: 'Decision maker', value: 'Unknown — Dana or the owner', kind: 'unknown' },
    ],
    opening:
      'Hi Dana, it’s David from Callie — you asked me to call back this morning when Marcus is in. Is now still good for five minutes?',
    questions: [
      'When a tenant calls about a leak at 9 pm, what happens between that call and a vendor being dispatched?',
      'Roughly how many maintenance calls a week does Marcus handle himself?',
    ],
    research: [
      {
        heading: 'Maintenance workload',
        body: 'Their careers page has listed a “Maintenance Coordinator (bilingual)” role since August. Reviews mention slow responses to repair requests on weekends.',
        sources: [1, 2],
      },
      {
        heading: 'Change evidence',
        body: 'Website shows 380 doors in a June snapshot and about 420 now: growth of roughly 10% in a quarter.',
        sources: [0, 3],
      },
    ],
    sources: [
      { title: 'Trinity Ridge — About us', url: 'https://trinityridge.example.test/about', observed: '24 Sep 2026' },
      { title: 'Trinity Ridge — Careers', url: 'https://trinityridge.example.test/careers', observed: '24 Sep 2026' },
      { title: 'Public review listing', url: 'https://reviews.example.test/trinity-ridge', observed: '24 Sep 2026' },
      { title: 'Web archive snapshot, June 2026', url: 'https://archive.example.test/trinityridge/2026-06', observed: '24 Sep 2026' },
    ],
    contacts: [
      { name: 'Dana Whitfield', role: 'Operations Manager', phone: '(817) 555-0142 ext. 3', email: 'dana@trinityridge.example.test', primary: true },
      { name: 'Marcus Lee', role: 'Maintenance Coordinator' },
      { name: 'Front desk', role: 'Main line', phone: '(817) 555-0142' },
    ],
    activity: [
      {
        at: 'Tue 30 Sep, 2:12 pm',
        kind: 'call',
        title: 'Call with Dana Whitfield',
        durationSec: 188,
        summary: [
          'Dana handles operations; Marcus coordinates maintenance and is in Thursday mornings.',
          'After-hours calls go to an answering service that “just takes messages.”',
          'Asked to be called back Thursday morning.',
        ],
      },
      { at: 'Mon 29 Sep, 11:05 am', kind: 'call', title: 'No answer', detail: 'Attempt 1 of 4 · voicemail script read' },
      { at: 'Wed 24 Sep', kind: 'note', title: 'Research brief created', detail: '4 sources' },
    ],
    nextActions: [
      { label: 'Callback with Dana (and Marcus)', due: 'Today 10:30 am' },
      { label: 'Send the one-page overview if asked', due: 'After the call' },
    ],
  },
  {
    id: 'cedar-hollow',
    name: 'Cedar Hollow Residential',
    city: 'Plano',
    state: 'TX',
    timeZone: 'America/Chicago',
    phone: '(972) 555-0117',
    website: 'cedarhollow.example.test',
    doors: '~650 doors',
    software: 'AppFolio',
    stage: 'interested',
    owner: 'David',
    queue: { reason: 'reply', line: 'Replied 8:52 am · asked about pricing' },
    whyThisFirm: 'Replied this morning to Tuesday’s follow-up asking how pricing works for 650 doors. Warm and time-sensitive.',
    askFor: { who: 'Priya Raman, Owner', note: 'She wrote the reply herself.' },
    facts: [
      { label: 'Doors', value: 'About 650', kind: 'verified', source: 'Her reply, 2 Oct' },
      { label: 'Software', value: 'AppFolio', kind: 'verified', source: 'Owner portal login page' },
      { label: 'Budget owner', value: 'Priya', kind: 'hypothesis' },
      { label: 'Current answering', value: 'Unknown', kind: 'unknown' },
    ],
    opening: 'Hi Priya, David from Callie — thanks for your note this morning. Happy to walk through pricing; can I ask two quick questions first?',
    questions: ['How are maintenance calls answered after 6 pm today?', 'Would you want to see it on sample data before anything else?'],
    research: [{ heading: 'Portfolio', body: 'Mostly single-family in Collin County; a handful of small multifamily.', sources: [0] }],
    sources: [{ title: 'Cedar Hollow — Properties', url: 'https://cedarhollow.example.test/properties', observed: '22 Sep 2026' }],
    contacts: [{ name: 'Priya Raman', role: 'Owner', email: 'priya@cedarhollow.example.test', primary: true }],
    activity: [
      { at: 'Today, 8:52 am', kind: 'email', title: 'Reply from Priya Raman', detail: '“How does pricing work for ~650 doors?”' },
      { at: 'Tue 30 Sep', kind: 'email', title: 'Follow-up sent', detail: 'Permitted follow-up after call' },
      { at: 'Mon 29 Sep', kind: 'call', title: 'Call with Priya Raman', durationSec: 241, summary: ['Interested in after-hours coverage.', 'Asked for an e-mail with details.'] },
    ],
    nextActions: [{ label: 'Answer the pricing question', due: 'Today' }],
    pipeline: {
      next: 'Answer pricing question',
      nextDue: 'Today',
      meeting: null,
      meetingState: 'none',
      value: { monthly: 1300, kind: 'estimated' },
    },
  },
  {
    id: 'lone-star',
    name: 'Lone Star Homes & Leasing',
    city: 'Arlington',
    state: 'TX',
    timeZone: 'America/Chicago',
    phone: '(682) 555-0163',
    website: 'lonestarhomes.example.test',
    doors: '~300 doors',
    software: 'AppFolio',
    stage: null,
    owner: 'David',
    queue: { reason: 'prospect', line: 'New · attempt 1 of 4', attempt: 1 },
    whyThisFirm: 'Independent single-family manager in Arlington with an AppFolio portal and a posted 24/7 maintenance line.',
    askFor: { who: 'The owner or whoever handles maintenance', note: 'No named contact yet.' },
    facts: [
      { label: 'Doors', value: 'About 300', kind: 'hypothesis' },
      { label: 'Software', value: 'AppFolio', kind: 'verified', source: 'Tenant portal link' },
      { label: 'Maintenance line', value: '24/7 number posted', kind: 'verified', source: 'Website · Residents' },
      { label: 'Owner', value: 'Unknown', kind: 'unknown' },
    ],
    opening: 'Hi, this is David from Callie. Who handles maintenance calls for your rentals?',
    questions: ['Who picks up the 24/7 line at night?', 'How many of those calls are real emergencies?'],
    research: [{ heading: 'Website', body: 'Residents page lists a 24/7 maintenance number different from the office line.', sources: [0] }],
    sources: [{ title: 'Lone Star — Residents', url: 'https://lonestarhomes.example.test/residents', observed: '1 Oct 2026' }],
    contacts: [{ name: 'Main line', role: 'Office', phone: '(682) 555-0163', primary: true }],
    activity: [{ at: 'Wed 1 Oct', kind: 'note', title: 'Added from the DFW batch' }],
    nextActions: [{ label: 'First call', due: 'Today' }],
  },
  {
    id: 'brazos-valley',
    name: LONG_NAME,
    city: 'Grapevine',
    state: 'TX',
    timeZone: 'America/Chicago',
    phone: '(817) 555-0188',
    website: 'brazosvalleyresidential.example.test',
    doors: '~900 doors',
    software: 'AppFolio',
    stage: null,
    owner: 'David',
    queue: { reason: 'prospect', line: 'New · attempt 2 of 4', attempt: 2 },
    whyThisFirm: 'Large for the target band (about 900 doors) but still independent; recent hiring for after-hours dispatch.',
    askFor: { who: 'Director of Maintenance', note: 'Title from the team page; name not listed.' },
    facts: [
      { label: 'Doors', value: 'About 900', kind: 'verified', source: 'Website · Home' },
      { label: 'Software', value: 'AppFolio', kind: 'verified', source: 'Owner portal' },
      { label: 'Ownership', value: 'Unknown', kind: 'unknown' },
    ],
    opening: 'Hi, this is David from Callie — could I speak with whoever runs maintenance?',
    questions: ['Who covers after-hours dispatch today?', 'What does a weekend look like for that team?'],
    research: [{ heading: 'Hiring', body: 'Posted an “After-hours dispatcher” role on 18 Sep.', sources: [0] }],
    sources: [{ title: 'Brazos Valley — Careers', url: 'https://brazosvalleyresidential.example.test/careers', observed: '29 Sep 2026' }],
    contacts: [{ name: 'Main line', role: 'Office', phone: '(817) 555-0188', primary: true }],
    activity: [{ at: 'Tue 30 Sep, 3:40 pm', kind: 'call', title: 'No answer', detail: 'Attempt 1 of 4 · voicemail script read' }],
    nextActions: [{ label: 'Attempt 2 (after 11:40 am)', due: 'Today' }],
  },
  {
    id: 'prairie-creek',
    name: 'Prairie Creek Property Group',
    city: 'Frisco',
    state: 'TX',
    timeZone: 'America/Chicago',
    phone: '(469) 555-0121',
    website: 'prairiecreek.example.test',
    doors: '~240 doors',
    software: 'AppFolio',
    stage: null,
    owner: 'David',
    queue: { reason: 'prospect', line: 'New · attempt 1 of 4', attempt: 1 },
    whyThisFirm: 'Single-family manager in Frisco; residents page says maintenance requests are “answered next business day.”',
    askFor: { who: 'Office manager', note: '' },
    facts: [
      { label: 'Doors', value: 'About 240', kind: 'hypothesis' },
      { label: 'Software', value: 'AppFolio', kind: 'verified', source: 'Tenant portal' },
    ],
    opening: 'Hi, this is David from Callie. Who handles maintenance calls for your homes?',
    questions: ['What happens with a maintenance call on a Saturday?', 'Who would decide on changing that?'],
    research: [],
    sources: [],
    contacts: [{ name: 'Main line', role: 'Office', phone: '(469) 555-0121', primary: true }],
    activity: [],
    nextActions: [{ label: 'First call', due: 'Today' }],
  },
  {
    id: 'bluebonnet',
    name: 'Bluebonnet Leasing Co.',
    city: 'Denton',
    state: 'TX',
    timeZone: 'America/Chicago',
    phone: null,
    website: 'bluebonnetleasing.example.test',
    doors: 'Unknown',
    software: 'AppFolio',
    stage: null,
    owner: 'David',
    queue: { reason: 'prospect', line: 'No phone number' },
    whyThisFirm: 'AppFolio single-family manager in Denton found through the batch search.',
    askFor: { who: 'Owner', note: '' },
    facts: [{ label: 'Phone', value: 'Unknown', kind: 'unknown' }],
    opening: '',
    questions: ['', ''],
    research: [],
    sources: [],
    contacts: [],
    activity: [{ at: 'Wed 1 Oct', kind: 'note', title: 'Added from the DFW batch' }],
    nextActions: [],
  },
  {
    id: 'elm-fork',
    name: 'Elm Fork Rentals',
    city: null,
    state: null,
    timeZone: null,
    phone: '(214) 555-0175',
    website: 'elmforkrentals.example.test',
    doors: '~180 doors',
    software: 'Unknown',
    stage: null,
    owner: 'David',
    queue: { reason: 'prospect', line: 'No location or time zone' },
    whyThisFirm: 'Website lists Dallas-area homes but no office address.',
    askFor: { who: 'Owner', note: '' },
    facts: [{ label: 'Location', value: 'Unknown', kind: 'unknown' }],
    opening: '',
    questions: ['', ''],
    research: [],
    sources: [],
    contacts: [{ name: 'Main line', role: 'Office', phone: '(214) 555-0175', primary: true }],
    activity: [],
    nextActions: [],
  },
];

/** Firms only on the board (not in today's queue). */
export const BOARD_ONLY: readonly Pick<Firm, 'id' | 'name' | 'city' | 'stage' | 'pipeline'>[] = [
  {
    id: 'ne-tarrant',
    name: 'Northeast Tarrant County Scattered-Site Residential Management Partners',
    city: 'Hurst',
    stage: 'interested',
    pipeline: { next: 'Send demo times', nextDue: 'Fri 3 Oct', meeting: 'Demo requested', meetingState: 'requested', value: { monthly: 1800, kind: 'estimated' } },
  },
  {
    id: 'white-rock',
    name: 'White Rock Residential',
    city: 'Dallas',
    stage: 'demo_booked',
    pipeline: { next: 'Demo', nextDue: 'Tue 7 Oct, 11 am', meeting: 'Demo Tue 7 Oct, 11 am', meetingState: 'confirmed', value: { monthly: 1100, kind: 'estimated' } },
  },
  {
    id: 'denton-oaks',
    name: 'Denton Oaks Management',
    city: 'Denton',
    stage: 'demo_booked',
    pipeline: { next: 'Demo', nextDue: 'Thu 9 Oct, 3 pm', meeting: 'Demo Thu 9 Oct, 3 pm', meetingState: 'confirmed', value: null },
  },
  {
    id: 'mesquite-square',
    name: 'Mesquite Square Rentals',
    city: 'Mesquite',
    stage: 'decision_pending',
    pipeline: { next: 'Check in on decision', nextDue: 'Mon 6 Oct', meeting: 'Demo held 29 Sep', meetingState: 'held', value: { monthly: 760, kind: 'estimated' } },
  },
  {
    id: 'lakewood-pm',
    name: 'Lakewood Park Property Management',
    city: 'Dallas',
    stage: 'onboarding',
    pipeline: { next: 'Import vendor list', nextDue: 'Fri 3 Oct', meeting: 'Kickoff held 30 Sep', meetingState: 'held', value: { monthly: 1240, kind: 'agreed' } },
  },
  {
    id: 'irving-commons',
    name: 'Irving Commons Homes',
    city: 'Irving',
    stage: 'live',
    pipeline: { next: 'Monthly check-in', nextDue: 'Wed 15 Oct', meeting: null, meetingState: 'none', value: { monthly: 199, kind: 'agreed' } },
  },
  {
    id: 'keller-crossing',
    name: 'Keller Crossing Homes',
    city: 'Keller',
    stage: 'lost',
    pipeline: { next: 'Revisit next quarter', nextDue: 'Jan 2027', meeting: 'Demo held 12 Sep', meetingState: 'held', value: { monthly: 540, kind: 'estimated' } },
  },
];

export const STAGES: readonly { readonly id: Stage; readonly label: string }[] = [
  { id: 'interested', label: 'Interested' },
  { id: 'demo_booked', label: 'Demo booked' },
  { id: 'decision_pending', label: 'Decision pending' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'live', label: 'Live' },
  { id: 'lost', label: 'Lost' },
];

export const ANNOUNCEMENT = 'Hi, this is David from Callie. This call is being recorded and transcribed for my notes.';

/** Why a firm cannot be called, or null when it can. */
export function ineligibility(firm: Firm): { readonly title: string; readonly detail: string; readonly field: string } | null {
  if (firm.phone === null) {
    return {
      title: 'No phone number',
      detail: 'Callie needs a number to dial. Add the office or a contact’s number and the firm joins today’s queue straight away.',
      field: 'Phone',
    };
  }
  if (firm.timeZone === null || firm.city === null) {
    return {
      title: 'No location or time zone',
      detail: 'Callie only calls inside the firm’s local business hours, so it needs the city and state (the time zone follows). Add them to make the firm eligible.',
      field: 'Location',
    };
  }
  return null;
}

export const firmById = (id: string): Firm | undefined => FIRMS.find(firm => firm.id === id);
