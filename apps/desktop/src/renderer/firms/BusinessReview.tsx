import { useEffect, useState } from 'react';
import type { BusinessPolicy, BusinessReviewPage } from '@fss/contracts';
export interface BusinessReviewPorts {
  policy(): Promise<BusinessPolicy>;
  review?(mailboxId: string, after?: string): Promise<BusinessReviewPage>;
  decide?(input: {
    mailboxId: string;
    conversationId: string;
    expectedAccountBinding: string;
    expectedGeneration: number;
    expectedPolicyRevision: number;
    expectedMetadataRevision: number;
    expectedDecisionRevision: number;
    decision: 'include' | 'exclude';
  }): Promise<{
    decisionRevision: number;
    captureAllowed: false;
  }>;
  savePolicy(input: {
    mailboxId: string;
    expectedGeneration: number;
    expectedAccountBinding: string;
    expectedRevision: number;
    enabled: boolean;
    disclosure: {
      version: string;
      sha256: string;
    } | null;
  }): Promise<{
    revision: number;
  }>;
}
export function BusinessReview({ enabled, ports }: {
  enabled: boolean;
  ports: BusinessReviewPorts;
}) {
  const [policy, setPolicy] = useState<BusinessPolicy | null>(null);
  const [review, setReview] = useState<BusinessReviewPage | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { let current = true; if (enabled)
    void ports.policy().then(value => { if (current) {
      setPolicy(value);
      if (value.mailboxId !== null && ports.review)
        void ports.review(value.mailboxId).then(page => { if (current)
          setReview(page); }).catch(() => { if (current)
          setError('Conversation review is unavailable.'); });
    } }).catch(() => { if (current)
      setError('Conversation review is unavailable.'); }); return () => { current = false; }; }, [enabled, ports]);
  async function prepare() {
    if (policy?.mailboxId === null || policy?.mailboxId === undefined || policy.generation === null || policy.accountBinding === null || !approved)
      return;
    setBusy(true);
    setError(null);
    try {
      await ports.savePolicy({ mailboxId: policy.mailboxId, expectedGeneration: policy.generation, expectedAccountBinding: policy.accountBinding, expectedRevision: policy.revision, enabled: false, disclosure: { version: policy.metadataReviewDisclosure.version, sha256: policy.metadataReviewDisclosure.sha256 } });
      setPolicy(await ports.policy());
      if (ports.review)
        setReview(await ports.review(policy.mailboxId));
      setApproved(false);
    }
    catch {
      setError('Review preparation failed. Reload before trying again.');
    }
    finally {
      setBusy(false);
    }
  }
  async function decide(row: BusinessReviewPage['conversations'][number], decision: 'include' | 'exclude') {
    if (review === null || review.accountBinding === null || review.generation === null || ports.decide === undefined || ports.review === undefined)
      return;
    setBusy(true);
    setError(null);
    try {
      await ports.decide({ mailboxId: review.mailboxId, conversationId: row.conversationId, expectedAccountBinding: review.accountBinding, expectedGeneration: review.generation, expectedPolicyRevision: review.policyRevision, expectedMetadataRevision: row.metadataRevision, expectedDecisionRevision: row.decisionRevision, decision });
      setReview(await ports.review(review.mailboxId));
    }
    catch {
      setReview(null);
      setError('The conversation changed. Reload before making a decision.');
    }
    finally {
      setBusy(false);
    }
  }
  if (!enabled)
    return null;
  return <section aria-label="Conversation review"><h2>Conversation review</h2><p>Business conversation capture is off.</p><p>Metadata review does not fetch message bodies, use hosted AI or authorize sending. Capture remains subject to provider verification and release approval.</p>{error && <p role="alert">{error}</p>}{policy && <><p>{policy.emailAddress ?? 'Connect your own mailbox to prepare review.'}</p><p>{policy.metadataReviewDisclosureText}</p><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)}/>I approve metadata-only conversation review</label><button type="button" disabled={!approved || busy || policy.mailboxId === null || policy.accountBinding === null} onClick={() => void prepare()}>Prepare metadata review</button></>}{review && <><p>{review.available ? 'Metadata only; including a conversation does not enable capture.' : 'Metadata review is unavailable. Prepare consent for the current mailbox connection.'}</p>{review.conversations.map(row => <article key={row.conversationId}><h3>{row.subject || '(No subject)'}</h3><p>{row.participants.join(', ')}</p><p>{new Date(row.latestProviderAt).toLocaleString()}</p><p>{row.humanDecision === 'exclude' ? 'Excluded by you' : row.humanDecision === 'include' ? 'Included by you' : row.effectiveDecision === 'needs_review' ? 'Needs review' : row.effectiveDecision === 'excluded' ? 'Excluded by classification' : 'Included by classification'}</p><button type="button" disabled={busy || !review.available} onClick={() => void decide(row, 'include')}>Include conversation</button><button type="button" disabled={busy || !review.available} onClick={() => void decide(row, 'exclude')}>Exclude conversation</button></article>)}{review.nextAfter !== null && <button type="button" disabled={busy} onClick={() => { if (ports.review)
    void ports.review(review.mailboxId, review.nextAfter ?? undefined).then(next => setReview(!next.available || next.accountBinding !== review.accountBinding || next.generation !== review.generation || next.policyRevision !== review.policyRevision ? next : { ...next, conversations: [...review.conversations, ...next.conversations] })).catch(() => setError('More conversations could not be loaded.')); }}>Show more conversations</button>}</>}</section>;
}
