import {CorrespondentRules,type CorrespondentRulePorts} from './CorrespondentRules.tsx';
import {CaptureReadRecovery,type CaptureReadRecoveryPorts} from './CaptureReadRecovery.tsx';
import { CrmCapabilitiesSection, type CrmCapabilityPorts } from '../settings/CrmCapabilitiesSection.tsx';
import {MailImportStatus,type MailImportPorts} from './MailImportStatus.tsx';
import type {ProcessingPorts} from './ProcessingHealth.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BusinessPolicy, BusinessReviewPage } from '@fss/contracts';
import { EmailTimeline, type EmailTimelinePorts } from './EmailTimeline.tsx';
export interface BusinessReviewPorts {
  captureRecovery?:CaptureReadRecoveryPorts;
  selectionStatus?(input:{mailboxId:string;previewJobId:string}):Promise<{state:'pending'|'ready'|'unavailable';reason:string|null;conversationId:string|null}>;
  selectMessage?(input:{mailboxId:string;expectedGeneration:number;expectedAccountBinding:string;expectedPolicyRevision:number;providerMessageId:string}):Promise<{status:'queued';previewJobId:string;captureAllowed:false}>;
  rules?:CorrespondentRulePorts["rules"];
  saveRule?:CorrespondentRulePorts["saveRule"];
  capabilities?: CrmCapabilityPorts;
  imports?:MailImportPorts;
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
    decision: 'include' | 'exclude' | 'clear';
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
  const [selectedMessage,setSelectedMessage]=useState('');
  const [previewJobId,setPreviewJobId]=useState<string|null>(null);
  const [selectionNotice,setSelectionNotice]=useState('');
  const [policy, setPolicy] = useState<BusinessPolicy | null>(null);
  const [review, setReview] = useState<BusinessReviewPage | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [controlVersion, setControlVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Every read and mutation supersedes earlier publications, including pagination.
  const issuance = useRef(0);
  const invalidateReads = useCallback(() => ++issuance.current, []);
  useEffect(() => {
    const ticket = invalidateReads();
    setSelectedMessage("");setPreviewJobId(null);setSelectionNotice("");
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
  }, [enabled, ports, invalidateReads, controlVersion]);
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
  async function decide(row: BusinessReviewPage['conversations'][number], decision: 'include' | 'exclude' | 'clear') {
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
  async function selectMessage(){
    if(!ports.selectMessage||!policy?.mailboxId||!policy.accountBinding||!policy.generation||busy)return;
    const id=selectedMessage.trim().split('/').at(-1)??'';if(!/^[A-Za-z0-9_-]{1,128}$/u.test(id)){setError('Enter a Gmail message ID or message link.');return;}
    const ticket=invalidateReads();setBusy(true);setError(null);try{const result=await ports.selectMessage({mailboxId:policy.mailboxId,expectedGeneration:policy.generation,expectedAccountBinding:policy.accountBinding,expectedPolicyRevision:policy.revision,providerMessageId:id});if(ticket===issuance.current){setPreviewJobId(result.previewJobId);setSelectionNotice('Metadata preview queued. Refresh review when ready, then confirm Include or Exclude. No bodies have been requested.');setSelectedMessage('');}}catch{if(ticket===issuance.current)setError('The message could not be selected. Verify acquisition setup and current account before trying again.');}finally{if(ticket===issuance.current)setBusy(false);}
  }
  async function refreshReview(){if(!ports.review||!policy?.mailboxId)return;const ticket=invalidateReads();if(previewJobId&&ports.selectionStatus){const status=await ports.selectionStatus({mailboxId:policy.mailboxId,previewJobId});if(ticket!==issuance.current)return;if(status.state==='unavailable'){setSelectionNotice('');setError(`Selection unavailable: ${(status.reason??'selection_unavailable').replaceAll('_',' ')}. Check current acquisition setup.`);}else if(status.state==='ready'){setSelectionNotice('Metadata preview ready. Confirm Include or Exclude for this conversation.');}}const page=await ports.review(policy.mailboxId);if(ticket===issuance.current)setReview(page);}
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
  const copiedEmailTimeline = <>{ports.captureRecovery&&policy?.mailboxId?<CaptureReadRecovery key={`capture-recovery:${privacyKey}:${policy.mailboxId}`} ports={ports.captureRecovery} mailboxId={policy.mailboxId} privacyKey={privacyKey}/>:null}{mail && policy?.mailboxId ? <EmailTimeline processing={processing} workspaceId={workspaceId} key={`email:${policy.mailboxId}`} enabled={enabled} ports={mail} mailboxId={policy.mailboxId} privacyKey={privacyKey} sourceVersion={sourceVersion} onSourceChange={onSourceChange} firms={mailFirms} /> : null}</>;
  return <section aria-label="Conversation review"><h2>Conversation review</h2>{ports.imports&&policy?.mailboxId&&policy.generation!==null&&policy.accountBinding!==null?<MailImportStatus ports={ports.imports} enabled={enabled} mailboxId={policy.mailboxId} privacyKey={privacyKey} generation={policy.generation} accountBinding={policy.accountBinding} sourceVersion={sourceVersion}/>:null}{policy?.mailboxId&&ports.selectMessage?<section aria-label="Add missed conversation"><h3>Add a missed or older conversation</h3><p>Preview one message in {policy.emailAddress}. Metadata only; optional person or firm association happens after capture in the timeline.</p><label>Gmail message ID or link<input value={selectedMessage} onChange={e=>setSelectedMessage(e.target.value)}/></label><button disabled={busy||!selectedMessage.trim()} onClick={()=>void selectMessage()}>Preview selected conversation</button><button disabled={busy} onClick={()=>void refreshReview().catch(()=>setError('Review unavailable.'))}>Refresh conversation review</button>{selectionNotice?<p role="status">{selectionNotice}</p>:null}</section>:null}{copiedEmailTimeline}{policy&&ports.rules&&ports.saveRule?<CorrespondentRules policy={policy} ports={{rules:ports.rules,saveRule:ports.saveRule}}/>:null}{ports.capabilities ? <CrmCapabilitiesSection scope="mail" available={enabled && !busy} privacyKey={privacyKey} {...(policy?.mailboxId ? { mailboxId: policy.mailboxId } : {})} ports={ports.capabilities} refreshVersion={policy?.revision ?? 0} onChange={() => setControlVersion(value => value + 1)} /> : <p>Business conversation capture is off.</p>}<p>Metadata review does not fetch message bodies, use hosted AI or authorize sending. Capture remains subject to provider verification and release approval.</p>{error && <p role="alert">{error}</p>}{policy && <><p>{policy.emailAddress ?? 'Connect your own mailbox to prepare review.'}</p><p>{policy.metadataReviewDisclosureText}</p><label><input type="checkbox" checked={approved} onChange={event => setApproved(event.target.checked)}/>I approve metadata-only conversation review</label><button type="button" disabled={!approved || busy || policy.mailboxId === null || policy.accountBinding === null} onClick={() => void prepare()}>Prepare metadata review</button></>}{review && <><p>{review.available ? 'Metadata only; including a conversation does not enable capture.' : 'Metadata review is unavailable. Prepare consent for the current mailbox connection.'}</p>{review.conversations.map(row => <article key={row.conversationId}><h3>{row.subject || '(No subject)'}</h3><p>{row.participants.join(', ')}</p><p>{new Date(row.latestProviderAt).toLocaleString()}</p><p>{row.humanDecision === 'exclude' ? 'Excluded by you' : row.humanDecision === 'include' ? 'Included by you' : row.effectiveDecision === 'needs_review' ? 'Needs review' : row.effectiveDecision === 'excluded' ? 'Excluded by classification' : 'Included by classification'}</p><button type="button" disabled={busy || !review.available} onClick={() => void decide(row, 'include')}>Include conversation</button><button type="button" disabled={busy || !review.available} onClick={() => void decide(row, 'exclude')}>Exclude conversation</button>{row.humanDecision!==null?<button type="button" disabled={busy||!review.available} onClick={()=>void decide(row,'clear')}>Remove conversation decision</button>:null}</article>)}{review.nextAfter !== null && <button type="button" disabled={busy} onClick={() => void loadMore()}>Show more conversations</button>}</>}</section>;
}
