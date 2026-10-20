import type { TemplateVersionRow } from '../templates/templates.ts';

/** Reviewed October 19 copy. Named fields are deliberately never inferred from notes or CRM. */
export const REVIEWED_RECAP_SUBJECT = 'Callie + {Firm}';
export const REVIEWED_RECAP_BODY = `Hi {Name},

Thanks for the time today. Sounds like {their main headache, in their words} is the big one.

Quick recap:
- Tenants text or call Callie, and it gets the details and photos
- It texts your vendors and follows up until a time is booked
- Nothing gets sent out without your OK

Next step is our setup call on {day} at {time}. Before then, could you send over:
- the 20 to 30 doors you want in the pilot (address, unit, tenant name and cell)
- your vendor list (name, trade, number)
- who should approve repairs

The pilot is $3 a door per month, starts when you go live, and you can cancel anytime. You'll get the agreement and payment link on go-live day.

Talk soon,
David`;

export const RECAP_FIELDS_UNRESOLVED = 'recap_fields_unresolved';

/** Also refuse malformed/unknown curly fields so editing cannot turn a typo into send authority. */
export function hasUnresolvedMeetingFields(subject: string, body: string): boolean {
  return /[{}]/u.test(subject + '\n' + body);
}

/** Only this exact existing-variable wrapper represents the reviewed recap, never arbitrary copy. */
export function isReviewedRecapWrapper(template: TemplateVersionRow): boolean {
  return template.subject === 'Callie + {firm_name}'
    && template.body === '{meeting_recap}\n\nTalk soon,\nDavid'
    && template.footerSignOff === 'Talk soon,\nDavid'
    && template.requiredVariables.includes('meeting_recap')
    && template.requiredVariables.every(name => name === 'meeting_recap' || name === 'firm_name');
}
