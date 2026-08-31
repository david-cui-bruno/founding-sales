import {
  ACTION_OUTCOMES,
  defineCadence,
  type CadenceActionComponent,
  type CadenceActionType,
  type CadenceAggregate,
  type CadenceAggregateDraft,
  type CadenceOutcomeTransition,
  type CadenceStep,
} from './cadenceTypes';

export { computeCadenceContentHash, parseCadenceAggregate } from './cadenceTypes';

const complete = { kind: 'complete_step' } as const;
const stopReplied = { kind: 'stop', reason: 'replied' } as const;
const stopOptedOut = { kind: 'stop', reason: 'opted_out' } as const;

function next(componentId: string): CadenceOutcomeTransition {
  return { kind: 'next_component', componentId };
}

function component(input: {
  id: string;
  sequence: number;
  actionType: CadenceActionType;
  condition?: string | null;
  body: string;
  success: CadenceOutcomeTransition;
  noAnswer?: CadenceOutcomeTransition;
  impossible?: CadenceOutcomeTransition;
  replied?: CadenceOutcomeTransition;
}): CadenceActionComponent {
  const outcomes: Partial<Record<string, CadenceOutcomeTransition>> = {
    failed: { kind: 'retry_component', componentId: input.id },
    channel_unavailable: { kind: 'resolve_contact_method', componentId: input.id },
    marked_impossible: input.impossible ?? input.success,
  };
  if (input.actionType === 'call') {
    outcomes.answered = input.success;
    outcomes.no_answer = input.noAnswer ?? input.success;
    outcomes.opted_out = stopOptedOut;
  } else if (input.actionType === 'voicemail') {
    outcomes.voicemail_left = input.success;
  } else {
    outcomes.accepted = input.success;
    outcomes.replied = input.replied ?? stopReplied;
    outcomes.opted_out = stopOptedOut;
  }
  const channel = input.actionType === 'call' ? 'phone' : input.actionType;
  return {
    id: input.id,
    sequence: input.sequence,
    actionType: input.actionType,
    channel,
    condition: input.condition ?? null,
    allowedOutcomes: [...ACTION_OUTCOMES[input.actionType]],
    outcomes: outcomes as CadenceActionComponent['outcomes'],
    template: { id: `${input.id}-template-v1`, version: 1, body: input.body },
  };
}

function step(input: {
  definitionId: string;
  sequence: number;
  dayOffset: number;
  label: string;
  breakup?: boolean;
  immediate?: boolean;
  differentCallWindow?: boolean;
  finalSlaDayOffset?: number | null;
  components: CadenceActionComponent[];
}): CadenceStep {
  return {
    id: `${input.definitionId}-day-${input.dayOffset}`,
    sequence: input.sequence,
    dayOffset: input.dayOffset,
    label: input.label,
    breakup: input.breakup ?? false,
    timing: {
      kind: input.immediate === true ? 'immediate' : 'policy_window',
      differentCallWindow: input.differentCallWindow ?? false,
      finalSlaDayOffset: input.finalSlaDayOffset ?? null,
    },
    components: input.components,
  };
}

const policies = {
  call: 'founder_call_v1', text: 'founder_text_v1', email: 'founder_email_v1',
} as const;

function cadenceA(): CadenceAggregateDraft {
  const id = 'cadence-a-v1';
  const d0vm = `${id}-day-0-voicemail`;
  const d0text = `${id}-day-0-text`;
  const d5vm = `${id}-day-5-voicemail`;
  return {
    id, family: 'cadence_a', version: 1, name: 'FRBO / Live Vacancy',
    category: 'prospecting', attemptCap: 8, policyIds: policies,
    steps: [
      step({ definitionId: id, sequence: 0, dayOffset: 0, label: 'Immediate call, voicemail, and text', immediate: true, components: [
        component({ id: `${id}-day-0-call`, sequence: 0, actionType: 'call', body: 'Call {{first_name}} within minutes of the live listing alert.', success: complete, noAnswer: next(d0vm), impossible: next(d0vm) }),
        component({ id: d0vm, sequence: 1, actionType: 'voicemail', condition: 'after:no_answer', body: 'Leave a voicemail no longer than 20 seconds; say a text is coming next.', success: next(d0text), impossible: next(d0text) }),
        component({ id: d0text, sequence: 2, actionType: 'text', condition: 'after:voicemail_left_or_impossible', body: 'Hi {{first_name}} — just tried you about the {{property_context}} repair/listing. I help Providence landlords get repair work moving without chasing contractors. Worth a quick conversation?', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 1, dayOffset: 1, label: 'Call in a different window', differentCallWindow: true, components: [
        component({ id: `${id}-day-1-call`, sequence: 0, actionType: 'call', body: 'Call in a different window from the prior call. Do not leave a voicemail.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 2, dayOffset: 3, label: 'Providence value-angle text', components: [
        component({ id: `${id}-day-3-text`, sequence: 0, actionType: 'text', body: 'happy to share what other Providence landlords tell me about finding contractors — no pitch required.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 3, dayOffset: 5, label: 'Call and second voicemail', components: [
        component({ id: `${id}-day-5-call`, sequence: 0, actionType: 'call', body: 'Call and leave the second voicemail only after no answer.', success: complete, noAnswer: next(d5vm), impossible: next(d5vm) }),
        component({ id: d5vm, sequence: 1, actionType: 'voicemail', condition: 'after:no_answer', body: 'Leave voicemail number two, concise and specific to {{property_context}}.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 4, dayOffset: 8, label: 'Two-line email', components: [
        component({ id: `${id}-day-8-email`, sequence: 0, actionType: 'email', body: 'Subject: repairs at {{property_context}}\nI help Providence landlords get reliable repair coverage without contractor chasing. Demo: {{demo_number}}', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 5, dayOffset: 11, label: 'Call without voicemail', components: [
        component({ id: `${id}-day-11-call`, sequence: 0, actionType: 'call', body: 'Call once. Do not leave a voicemail.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 6, dayOffset: 12, label: 'Soft text', components: [
        component({ id: `${id}-day-12-text`, sequence: 0, actionType: 'text', body: 'Still happy to be useful if contractor coverage is ever the bottleneck — no need to respond now.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 7, dayOffset: 14, label: 'Breakup text', breakup: true, components: [
        component({ id: `${id}-day-14-text`, sequence: 0, actionType: 'text', body: 'closing my file — if a repair ever has you chasing plumbers, this number will still work.', success: complete }),
      ] }),
    ],
  };
}

function cadenceB(): CadenceAggregateDraft {
  const id = 'cadence-b-v1';
  const d0vm = `${id}-day-0-voicemail`;
  const d0text = `${id}-day-0-text`;
  const d9vm = `${id}-day-9-voicemail`;
  return {
    id, family: 'cadence_b', version: 1, name: 'Registry / Scored Cold List',
    category: 'prospecting', attemptCap: 6, policyIds: policies,
    steps: [
      step({ definitionId: id, sequence: 0, dayOffset: 0, label: 'Research-framed call, voicemail, and text', immediate: true, components: [
        component({ id: `${id}-day-0-call`, sequence: 0, actionType: 'call', body: 'Research call: I am speaking with Providence rental owners about how repairs get handled; this is not a service pitch.', success: complete, noAnswer: next(d0vm), impossible: next(d0vm) }),
        component({ id: d0vm, sequence: 1, actionType: 'voicemail', condition: 'after:no_answer', body: 'Research-framed voicemail, 20 seconds or less, followed immediately by a text.', success: next(d0text), impossible: next(d0text) }),
        component({ id: d0text, sequence: 2, actionType: 'text', condition: 'after:voicemail_left_or_impossible', body: 'Hi {{first_name}} — I am researching how Providence rental owners handle urgent repairs and would value your perspective. Open to a short conversation?', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 1, dayOffset: 2, label: 'Call', components: [
        component({ id: `${id}-day-2-call`, sequence: 0, actionType: 'call', body: 'Second research-framed call. No voicemail.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 2, dayOffset: 5, label: 'Text', components: [
        component({ id: `${id}-day-5-text`, sequence: 0, actionType: 'text', body: 'One useful question: what part of finding a contractor costs you the most time today?', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 3, dayOffset: 9, label: 'Call and voicemail', components: [
        component({ id: `${id}-day-9-call`, sequence: 0, actionType: 'call', body: 'Third call; leave a concise voicemail after no answer.', success: complete, noAnswer: next(d9vm), impossible: next(d9vm) }),
        component({ id: d9vm, sequence: 1, actionType: 'voicemail', condition: 'after:no_answer', body: 'Final voicemail; name the research purpose and callback number.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 4, dayOffset: 13, label: 'Email', components: [
        component({ id: `${id}-day-13-email`, sequence: 0, actionType: 'email', body: 'Subject: Providence landlord repair research\nTwo quick lines on the research and the demo number: {{demo_number}}', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 5, dayOffset: 16, label: 'Breakup text', breakup: true, components: [
        component({ id: `${id}-day-16-text`, sequence: 0, actionType: 'text', body: 'Closing my research file for now. If repair coverage becomes painful later, this number will still work.', success: complete }),
      ] }),
    ],
  };
}

function cadenceC(): CadenceAggregateDraft {
  const id = 'cadence-c-v1';
  return {
    id, family: 'cadence_c', version: 1, name: 'Warm / Referral / Inbound',
    category: 'prospecting', attemptCap: 4, policyIds: policies,
    steps: [
      step({ definitionId: id, sequence: 0, dayOffset: 0, label: 'Same-day thank-you text', immediate: true, components: [
        component({ id: `${id}-day-0-text`, sequence: 0, actionType: 'text', body: 'Thank you for reaching out, {{first_name}} — I saw your note and will make this easy. When is a good time today or tomorrow?', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 1, dayOffset: 1, label: 'Book the substantive conversation', finalSlaDayOffset: 2, components: [
        component({ id: `${id}-day-1-call`, sequence: 0, actionType: 'call', body: 'Call to book the substantive conversation. Referral SLA ends after the final allowed Day-2 window.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 2, dayOffset: 4, label: 'Warm nudge', components: [
        component({ id: `${id}-day-4-text`, sequence: 0, actionType: 'text', body: 'Quick nudge — still happy to compare notes on {{property_context}} whenever useful.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 3, dayOffset: 8, label: 'Graceful breakup', breakup: true, components: [
        component({ id: `${id}-day-8-text`, sequence: 0, actionType: 'text', body: 'I will close the loop for now — thank you again, and this number stays open when the timing is better.', success: complete }),
      ] }),
    ],
  };
}

function postInterview(): CadenceAggregateDraft {
  const id = 'post-interview-v1';
  return {
    id, family: 'post_interview', version: 1, name: 'Post-Interview',
    category: 'post_stage', attemptCap: 2, policyIds: policies,
    steps: [
      step({ definitionId: id, sequence: 0, dayOffset: 0, label: 'Pain recap and call-two booking', immediate: true, components: [
        component({ id: `${id}-day-0-text`, sequence: 0, actionType: 'text', body: 'You said {{confirmed_pain}} — that is exactly what I fix. Let us book call two while the details are fresh.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 1, dayOffset: 2, label: 'Pitch call', components: [
        component({ id: `${id}-day-2-call`, sequence: 0, actionType: 'call', body: 'Pitch call: connect the offer to {{confirmed_pain}} and say the price plainly.', success: complete }),
      ] }),
    ],
  };
}

function postOffer(): CadenceAggregateDraft {
  const id = 'post-offer-v1';
  return {
    id, family: 'post_offer', version: 1, name: 'Post-Offer',
    category: 'post_stage', attemptCap: 5, policyIds: policies,
    steps: [
      step({ definitionId: id, sequence: 0, dayOffset: 0, label: 'One-pager and agreement', immediate: true, components: [
        component({ id: `${id}-day-0-email`, sequence: 0, actionType: 'email', body: 'Here is the one-pager and agreement link we discussed: {{agreement_link}}. The plan reflects {{confirmed_pain}}.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 1, dayOffset: 2, label: 'Nudge', components: [
        component({ id: `${id}-day-2-text`, sequence: 0, actionType: 'text', body: 'Quick nudge on the agreement — anything I can make clearer?', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 2, dayOffset: 5, label: 'Mutual-action text', components: [
        component({ id: `${id}-day-5-text`, sequence: 0, actionType: 'text', body: 'You said you would try it on {{trial_commitment}} — still good for {{stated_week}}?', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 3, dayOffset: 9, label: 'Last value call', components: [
        component({ id: `${id}-day-9-call`, sequence: 0, actionType: 'call', body: 'Last value call: resolve one concrete blocker and restate the agreed trial outcome.', success: complete }),
      ] }),
      step({ definitionId: id, sequence: 4, dayOffset: 12, label: 'Breakup text', breakup: true, components: [
        component({ id: `${id}-day-12-text`, sequence: 0, actionType: 'text', body: 'I will close this out for now. If the repair problem returns, the agreement and this number will still be here.', success: complete }),
      ] }),
    ],
  };
}

function onboarding(): CadenceAggregateDraft {
  const id = 'onboarding-v1';
  const stripe = `${id}-day-0-stripe-link`;
  const firstJob = `${id}-day-0-first-job`;
  return {
    id, family: 'onboarding', version: 1, name: 'Won Onboarding',
    category: 'onboarding', attemptCap: 1, policyIds: policies,
    steps: [
      step({ definitionId: id, sequence: 0, dayOffset: 0, label: 'Ten-minute onboarding', immediate: true, components: [
        component({ id: `${id}-day-0-welcome`, sequence: 0, actionType: 'text', body: 'Welcome to Callie, {{first_name}} — we are getting your founding account live now.', success: next(stripe), replied: next(stripe), impossible: next(stripe) }),
        component({ id: stripe, sequence: 1, actionType: 'text', condition: 'after:welcome', body: 'Complete payment here: {{stripe_link}}', success: next(firstJob), replied: next(firstJob), impossible: next(firstJob) }),
        component({ id: firstJob, sequence: 2, actionType: 'text', condition: 'after:stripe_link', body: 'Text your first job to this number now.', success: complete, replied: complete }),
      ] }),
    ],
  };
}

export const BUILTIN_CADENCES: readonly CadenceAggregate[] = Object.freeze([
  cadenceA(), cadenceB(), cadenceC(), postInterview(), postOffer(), onboarding(),
].map((draft) => deepFreeze(defineCadence(draft))));

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
