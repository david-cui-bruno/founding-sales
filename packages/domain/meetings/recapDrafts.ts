import type { MeetingOutcomesView } from '@fss/contracts';
import { hasOptOutLink } from '@fss/contracts';
import { renderTemplateVersion, type TemplateVersionRow } from '../templates/templates.ts';
import { renderedHash } from '../outbound/fence.ts';

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const urls = (value: string) => [...new Set(value.match(/https:\/\/[^\s<>()]+/gu) ?? [])];
export type RecapContent = { ok: true; subject: string; body: string; renderedHash: string; materialReferences: string[] }
  | { ok: false; reasons: string[] };

/** Meeting text supplies context. Product/offer/material claims must already be approved template bytes. */
export function buildMeetingRecapContent(input: {
  mode?: 'recap' | 'reminder'; outcomes: MeetingOutcomesView; template: TemplateVersionRow; variables: Readonly<Record<string, string>>;
}): RecapContent {
  const { outcomes, template } = input;
  if (template.approvedAt === null || template.retiredAt !== null) return { ok: false, reasons: ['template_unapproved'] };
  const reminder = input.mode === 'reminder';
  const reasons = outcomes.holds.filter(reason => reason !== 'analysis_disabled');
  if (outcomes.state !== 'current') reasons.push('notes_incomplete');
  if (!template.requiredVariables.includes('meeting_recap') || !template.body.includes('{meeting_recap}')) reasons.push('recap_template_required');
  if (reminder && !/\b(?:following up|follow[ -]?up|reminder|checking in)\b/iu.test(template.subject + ' ' + template.body)) reasons.push('reminder_template_required');
  const context: string[] = [], next: string[] = [], materialReferences: string[] = [];
  for (const item of outcomes.items) {
    if (item.reviewReasons.length > 0) { reasons.push(...item.reviewReasons); continue; }
    if (item.provenance !== 'stated') continue;
    if (['need', 'workflow', 'objection'].includes(item.kind)) context.push(item.text.replace(/\s+/gu, ' ').trim());
    else if (item.kind === 'material') {
      const requested = urls(item.text);
      const approved = urls(template.body);
      if (requested.length === 0 || requested.some(url => !approved.includes(url))) reasons.push('material_unavailable');
      else materialReferences.push(...requested);
    } else if (item.kind === 'commitment' || item.kind === 'next_step') {
      if (reminder && item.owner === 'you' && /\b(?:remind(?:er)?|follow[ -]?up|check[ -]?in|reach out)\b/iu.test(item.text)) continue;
      if (item.owner === 'unknown') reasons.push('owner_unknown');
      else if (item.owner === 'you' && !normalize(template.body).includes(normalize(item.text))) reasons.push('unsupported_commitment');
      else if (item.owner === 'prospect') next.push(item.text.replace(/\s+/gu, ' ').trim());
      // An approved host promise already appears in the template; do not duplicate it in a variable.
    }
  }
  const parts: string[] = [];
  if (context.length > 0) parts.push(`What we discussed:\n${context.map(text => `- ${text}`).join('\n')}`);
  if (next.length > 0) parts.push(`Your next steps:\n${next.map(text => `- ${text}`).join('\n')}`);
  if (reminder && parts.length === 0) parts.push('Our agreed follow-up.');
  if (parts.length === 0 && reasons.length === 0) reasons.push('recap_context_missing');
  if (reasons.length > 0) return { ok: false, reasons: [...new Set(reasons)].slice(0, 30) };
  const rendered = renderTemplateVersion(template, { ...input.variables, meeting_recap: parts.join('\n\n') });
  if (!rendered.rendered) return { ok: false, reasons: ['missing_variables'] };
  if (rendered.body.length > 4000 || rendered.subject.length > 998 || /[\r\n]/u.test(rendered.subject)
    || hasOptOutLink(rendered.subject) || hasOptOutLink(rendered.body) || /<[^>]+>/u.test(rendered.body)) return { ok: false, reasons: ['recap_content_invalid'] };
  return { ok: true, subject: rendered.subject, body: rendered.body, renderedHash: renderedHash(rendered.subject, rendered.body), materialReferences: [...new Set(materialReferences)] };
}
