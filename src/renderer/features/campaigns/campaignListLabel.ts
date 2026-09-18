import type { DailySnapshot } from '../../../shared/contracts/dailyContract';
import type { Enrollment } from '../../../shared/contracts/campaignContract';
import { describeCampaignTemplate, type OneCompanyCampaignChannel } from '../../../shared/contracts/callCampaignDraft';

type Campaign = DailySnapshot['campaigns'][number];
export type CampaignRowLabel = { title: string; detail: string };

/** The same nonterminal set as CallCampaignEnrollment's duplicate check and the campaign_one_nonterminal_account index. */
const NONTERMINAL_ENROLLMENT_STATES: ReadonlySet<Enrollment['state']> = new Set(['active', 'held', 'paused', 'conversation']);
export function isNonterminalEnrollment(enrollment: Pick<Enrollment, 'state'>): boolean {
  return NONTERMINAL_ENROLLMENT_STATES.has(enrollment.state);
}

const channelTitle: Record<OneCompanyCampaignChannel, string> = { call: 'Call campaign', linkedin: 'LinkedIn campaign' };

/**
 * List copy for one saved campaign version. The two exact one-company templates read as company · channel, a version the
 * worker derived from the territory call policy as company · Territory policy v<revision>, each with a plain state (Draft,
 * Approved, or Enrolled while a nonterminal enrollment exists); every other version keeps its saved campaign id and the
 * recorded approval wording. Presentation only: it never decides eligibility, approval or enrollment.
 */
export function describeCampaignRow(campaign: Campaign, accounts: DailySnapshot['accounts']): CampaignRowLabel {
  const { version } = campaign;
  const template = describeCampaignTemplate(version);
  if (!template) return { title: version.campaignId, detail: `Version ${version.version} · ${version.approvedAt ? 'approval recorded' : 'not approved'}` };
  const company = accounts.find(a => a.account.id === template.accountId)?.account.name ?? template.accountId;
  const state = campaign.enrollments.some(isNonterminalEnrollment) ? 'Enrolled' : version.approvedAt ? 'Approved' : 'Draft';
  const title = template.kind === 'one_company' ? channelTitle[template.channel] : template.policyDescription;
  return { title: `${company} · ${title}`, detail: `Version ${version.version} · ${state}` };
}
