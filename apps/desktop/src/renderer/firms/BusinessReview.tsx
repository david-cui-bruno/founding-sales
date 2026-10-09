import type {ProcessingPorts} from './ProcessingHealth.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BusinessPolicy, BusinessReviewPage } from '@fss/contracts';
import { EmailTimeline, type EmailTimelinePorts } from './EmailTimeline.tsx';
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
export function BusinessReview({ processing,workspaceId,enabled, ports, mail, privacyKey = 'business-review', sourceVersion, onSourceChange, mailFirms = [] }: {
  enabled: boolean;
  processing?:ProcessingPorts | undefined;
  workspaceId?:string | undefined;
  ports: BusinessReviewPorts;
  mail?: EmailTimelinePorts;
  privacyKey?: string;
  sourceVersion?: number | undefined;
  onSourceChange?: (() => void) | undefined;
  mailFirms?: readonly {id:string;name:string}[];
}) {
  const [policy, setPolicy] = useState<BusinessPolicy | null>(null);
  const [review, setReview] = useState<BusinessReviewPage | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every read and mutation supersedes earlier publications, including pagination.
  const issuance = useRef(0);
  const invalidateReads = useCallback(() => ++issuance.current, []);
  useEffect(() => {
    const ticket = invalidateReads();
    setPolicy(null);
    setReview(null);
    setApproved(false);
    setBusy(false);
    setError(null);
    if (enabled) {
      void (async () => {
        try {
          const value = await ports.policy();
          if (ticket !== issuance.current) return;
          setPolicy(value);
          if (value.mailboxId !== null && ports.review) {
            const page = await ports.review(value.mailboxId);
            if (ticket === issuance.current) setReview(page);
          }
        } catch {
          if (ticket === issuance.current) {
            setReview(null);
            setError('Conversation review is unavailable.');
          }
        }
      })();
    }
    return () => { invalidateReads(); };
  }, [enabled, ports, invalidateReads]);
  async function prepare() {
    if (!enabled || policy?.mailboxId === null || policy?.mailboxId === undefined || policy.generation === null || policy.accountBinding === null || !approved) return;
    const ticket = invalidateReads();
    setBusy(true);
    setError(null);
    try {
      await ports.savePolicy({ mailboxId: policy.mailboxId, expectedGeneration: policy.generation, expectedAccountBinding: policy.accountBinding, expectedRevision: policy.revision, enabled: false, disclosure: { version: policy.metadataReviewDisclosure.version, sha256: policy.metadataReviewDisclosure.sha256 } });
      if (ticket !== issuance.current) return;
      const currentPolicy = await ports.policy();
      if (ticket !== issuance.current) return;
      setPolicy(currentPolicy);
      setReview(null);
      if (ports.review && currentPolicy.mailboxId !== null) {
        const page = await ports.review(currentPolicy.mailboxId);
        if (ticket !== issuance.current) return;
        setReview(page);
      }
      setApproved(false);
    } catch {
      if (ticket === issuance.current) {
        setReview(null);
        setError('Review preparation failed. Reload before trying again.');
      }
    } finally {
      if (ticket === issuance.current) setBusy(false);
    }
  }
  async function decide(row: BusinessReviewPage['conversations'][number], decision: 'include' | 'exclude') {
    if (!enabled || review === null || review.accountBinding === null || review.generation === null || ports.decide === undefined || ports.review === undefined) return;
    const ticket = invalidateReads();
    setBusy(true);
    setError(null);
    try {
      await ports.decide({ mailboxId: review.mailboxId, conversationId: row.conversationId, expectedAccountBinding: review.accountBinding, expectedGeneration: review.generation, expectedPolicyRevision: review.policyRevision, expectedMetadataRevision: row.metadataRevision, expectedDecisionRevision: row.decisionRevision, decision });
      if (ticket !== issuance.current) return;
      const page = await ports.review(review.mailboxId);
      if (ticket === issuance.current) setReview(page);
    } catch {
      if (ticket === issuance.current) {
        setReview(null);
        setError('The conversation changed. Reload before making a decision.');
      }
    } finally {
      if (ticket === issuance.current) setBusy(false);
    }
  }
  async function loadMore() {
    if (!enabled || busy || review === null || !review.available || review.nextAfter === null || ports.review === undefined) return;
    const ticket = invalidateReads();
    const base = review;
    setError(null);
    try {
      const next = await ports.review(base.mailboxId, base.nextAfter ?? undefined);
      if (ticket !== issuance.current) return;
      const sameBinding = next.available && next.accountBinding === base.accountBinding && next.generation === base.generation && next.policyRevision === base.policyRevision;
      setReview(sameBinding ? { ...next, conversations: [...base.conversations, ...next.conversations] } : next);
      if (!sameBinding) setApproved(false);
    } catch {
      if (ticket === issuance.current) {
        setReview(null);
        setError('More conversations could not be loaded.');
      }
    }
  }
  if (!enabled)
    return null;
  const copiedEmailTimeline = mail && policy?.mailboxId ? <EmailTimeline processing={processing} workspaceId={workspaceId} key={`email:${policy.mailboxId}`} enabled={enabled} ports={mail} mailboxId={policy.mailboxId} privacyKey={privacyKey} sourceVersion={sourceVersion} onSourceChange={onSourceChange} firms={mailFirms} /> : null;
  return <section aria-label="Conversation review"><h2>Conversation review</h2>{copiedEmailTimeline}<p>Business conversation capture is off.</p><p>Metadata review does not fetch message bodies, use hosted AI or authorize sending. Capture remains subject to provider verification and release approval.</p>{error && <p role="alert">{error}</p>}{policy && <><p>{policy.emailAddress ?? 'Connect your own mailbox to prepare review.'}</p><p>{policy.metadataReviewDisclosureText}</p><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)}/>I approve metadata-only conversation review</label><button type="button" disabled={!approved || busy || policy.mailboxId === null || policy.accountBinding === null} onClick={() => void prepare()}>Prepare metadata review</button></>}{review && <><p>{review.available ? 'Metadata only; including a conversation does not enable capture.' : 'Metadata review is unavailable. Prepare consent for the current mailbox connection.'}</p>{review.conversations.map(row => <article key={row.conversationId}><h3>{row.subject || '(No subject)'}</h3><p>{row.participants.join(', ')}</p><p>{new Date(row.latestProviderAt).toLocaleString()}</p><p>{row.humanDecision === 'exclude' ? 'Excluded by you' : row.humanDecision === 'include' ? 'Included by you' : row.effectiveDecision === 'needs_review' ? 'Needs review' : row.effectiveDecision === 'excluded' ? 'Excluded by classification' : 'Included by classification'}</p><button type="button" disabled={busy || !review.available} onClick={() => void decide(row, 'include')}>Include conversation</button><button type="button" disabled={busy || !review.available} onClick={() => void decide(row, 'exclude')}>Exclude conversation</button></article>)}{review.nextAfter !== null && <button type="button" disabled={busy} onClick={() => void loadMore()}>Show more conversations</button>}</>}</section>;
}
