import type {
  DailyAnswer,
  DailySnapshot,
} from '../../../shared/contracts/dailyContract';
import { describeCampaignTemplate } from '../../../shared/contracts/callCampaignDraft';
const copy = {
  call: { template: 'manual-call template', step: 'call step', draft: 'Call campaign draft', reviewed: 'Reviewed call campaign', approval: 'Approval alone does not enroll a company or place a call.' },
  linkedin: { template: 'manual-LinkedIn template', step: 'LinkedIn step', draft: 'LinkedIn campaign draft', reviewed: 'Reviewed LinkedIn campaign', approval: 'Approval alone does not enroll a company or send a message.' },
} as const;
export function CampaignReview({
  campaign,
  accounts,
  answers,
}: {
  campaign: DailySnapshot['campaigns'][number];
  accounts: DailySnapshot['accounts'];
  answers: DailyAnswer[];
}) {
  const { version } = campaign;
  const template = describeCampaignTemplate(version);
  const draft = template?.kind === 'one_company' ? template : null;
  const territory = template?.kind === 'territory_policy' ? template : null;
  const text = draft ? copy[draft.channel] : null;
  // Only LinkedIn drafts expose an exact campaign version binding. Shared account
  // membership alone must not relabel unrelated requested emails as sample drafts.
  const samples = answers.filter(
    (a) =>
      a.kind === 'manual_linkedin' && a.draft.campaignVersionId === version.id,
  );
  return (
    <section className="native-desk__campaign">
      <p className="native-desk__eyebrow">Saved campaign version {version.version}{text ? ` / ${text.template}` : territory ? ' / territory call policy' : ' / capability preview'}</p>
      <p>{text ? `Review this frozen company, offer, ${text.step} and lifetime limits before a separate enrollment. Selecting this version never starts outreach.`
        : territory ? 'Read-only. The worker derived this version from the approved territory call policy when it prepared the firm; it is approved and enrolled by the policy, never edited here.'
          : 'Read-only preview. Editing, approval, enrollment and activation are not available here.'}</p>
      <h2>{text ? version.approvedAt ? text.reviewed : text.draft : territory ? territory.policyDescription : version.campaignId}</h2>
      <h3>Offer</h3>
      <p>{version.offer}</p>
      <p>Objective: {version.objective}</p>
      <h3>Audience</h3>
      {draft ? <><p>Explicitly selected company: {accounts.find(a => a.account.id === draft.accountId)?.account.name ?? draft.accountId} ({draft.accountId}).</p><p>{draft.policyDescription}</p><p>This template description does not grant contact permission or authorize outreach.</p></>
        : territory ? <><p>{territory.audienceDescription}</p><p>This firm: {accounts.find(a => a.account.id === territory.accountId)?.account.name ?? territory.accountId} ({territory.accountId}).</p><p>Email steps are held until the mailbox is connected. This description does not grant contact permission or authorize outreach.</p></> : <p className="native-desk__hold">
        Audience definition unavailable. Review the source audience and its hash
        mapping in the source system. A hash is not an audience definition.
      </p>}
      <h4>Stored cohort</h4>
      <ul>
        {version.cohortAccountIds.map((id) => (
          <li key={id}>
            {accounts.find((a) => a.account.id === id)?.account.name ?? id}{' '}
            <small>({id})</small>
          </li>
        ))}
      </ul>
      <h3>Steps</h3>
      <ol>
        {version.steps.map((step) => (
          <li key={step.id}>
            {step.channel} · {step.condition.replaceAll('_', ' ')} · after{' '}
            {step.delayHours} hours
          </li>
        ))}
      </ol>
      <h3>Lifetime channel caps</h3>
      <p>
        {Object.entries(version.channelCaps)
          .map(([channel, cap]) => `${channel}: ${cap}`)
          .join(' · ')}
      </p>
      {campaign.caps.map((cap) => (
        <p key={cap.channel}>
          {cap.channel}: {cap.reserved} reserved, {cap.sent} recorded sent
        </p>
      ))}
      <h3>Exact saved samples</h3>
      {samples.length ? (
        samples.map(
          (a) =>
            a.kind === 'manual_linkedin' && (
              <details key={a.draft.id}>
                <summary>
                  Manual LinkedIn · {a.accountId} · revision {a.draft.revision}
                </summary>
                <pre>{a.draft.body}</pre>
              </details>
            ),
        )
      ) : (
        <p>No exact campaign-bound samples available.</p>
      )}
      <p>
        {version.approvedAt
          ? `Frozen approval recorded: ${version.approvedAt}. ${text ? text.approval : 'This does not activate new work.'}`
          : text
            ? `Not yet approved. Review the frozen offer, audience, step and limits above, then approve below. ${text.approval}`
            : 'Not approved. Approval is not available for this read-only version. Nothing here enrolls a company or starts outreach.'}
      </p>
      <details>
        <summary>Frozen identities and enrollments</summary>
        <p>Version ID: {version.id}</p>
        <p>Snapshot hash: {campaign.snapshotHash}</p>
        <p>Audience hash: {version.audienceHash}</p>
        <p>Content policy: {version.contentPolicyHash}</p>
        {campaign.enrollments.map((e) => (
          <p key={e.id}>
            {e.accountId} · {e.state} · route {e.selectedRouteId} v
            {e.selectedRouteVersion} · context {e.contextRevision}
          </p>
        ))}
      </details>
    </section>
  );
}
