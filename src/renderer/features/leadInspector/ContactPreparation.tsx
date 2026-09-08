import { useCallback, useEffect, useRef, useState } from 'react';
import { beginDiscoveryReceiptSchema, beginDiscoveryRequestSchema, discoveryBriefSchema,
  type BeginDiscoveryReceipt, type BeginDiscoveryRequest, type DiscoveryApi, type DiscoveryBrief } from '../../../shared/contracts/discoveryContract';
import { findContactInfoReceiptSchema, type FindContactInfoReceipt } from '../../../shared/contracts/enrichmentRequestContract';
import type { LeadDetail } from '../../../shared/contracts/leadDetailContract';
import { Button } from '../../components/Button';
import { supportsContactPreparation } from '../discovery/contactPreparationEligibility';
import { staleDiscoveryError } from '../discovery/useDiscovery';
import type { LeadDetailApi } from './useLeadInspector';

export const FIND_CONTACT_RECEIPTS: Readonly<Record<NonNullable<FindContactInfoReceipt['refusalReason']> | 'written', string>> = {
  written: 'Contact info requested. Results arrive with the next sync.',
  qualification_required: 'Contact preparation is required before lookup.',
  fit_gate_failed: 'Medium or High Fit is required.',
  identity_or_address_missing: 'A verified identity, cloud link, and usable property address are required.',
  direct_contact_exists: 'A usable verified contact is already on file.',
  suppression_blocked: 'Opt-out or suppression prevents contact enrichment.',
  rate_limited: 'Already requested in the last 30 days.',
  credentials_unavailable: 'Sourcing credentials are not provisioned.',
};
export type ContactPreparationRecord = {
  request?: BeginDiscoveryRequest;
  prepared?: BeginDiscoveryReceipt;
  busy?: boolean;
  lookup?: 'pending' | 'written' | 'uncertain';
  message?: string;
  waitUntil?: number;
  briefFlight?: Promise<DiscoveryBrief>;
};
const PENDING_HORIZON_MS = 35 * 60_000;
const noContacts = (detail: LeadDetail) => detail.phones.length === 0 && detail.emails.length === 0;

/** The provider retains command identity across selection changes. Rendering only reads. */
export function ContactPreparation({ detail, api, discoveryApi, record, isSelected, readDetail }: {
  detail: LeadDetail; api: LeadDetailApi; discoveryApi?: DiscoveryApi; record: ContactPreparationRecord;
  isSelected(): boolean; readDetail(): Promise<LeadDetail | null>;
}) {
  const [brief, setBrief] = useState<DiscoveryBrief | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [, redraw] = useState(0);
  const epoch = useRef(0);
  const active = useRef(true);
  const callbacks = useRef({ isSelected, readDetail });
  callbacks.current = { isSelected, readDetail };
  const cancellations = useRef(new Set<() => void>());
  const bounded = useCallback(<T,>(promise: Promise<T>, timeout = 15_000): Promise<T> => new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); cancellations.current.delete(cancel); reject(new Error('Preparation read unavailable')); };
    const timer = setTimeout(cancel, timeout);
    cancellations.current.add(cancel);
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); cancellations.current.delete(cancel); });
  }), []);
  const readBrief = useCallback(async () => {
    if (discoveryApi === undefined) throw new Error('Preparation unavailable');
    if (record.briefFlight === undefined) {
      const promise = Promise.resolve().then(() => {
        if (!active.current || !callbacks.current.isSelected()) throw new Error('Preparation reader disposed');
        return discoveryApi.getBrief({ personId: detail.personId });
      }).then(value => {
        const parsed = discoveryBriefSchema.parse(value);
        if (parsed.personId !== detail.personId || parsed.salesCycleId !== detail.salesCycleId) throw new Error('Mismatched owner');
        return parsed;
      });
      record.briefFlight = promise;
      const settled = () => { if (record.briefFlight === promise) record.briefFlight = undefined; };
      void promise.then(settled, settled);
    }
    return bounded(record.briefFlight);
  }, [bounded, detail.personId, detail.salesCycleId, discoveryApi, record]);
  useEffect(() => {
    const generation = ++epoch.current; active.current = true;
    const cancels = cancellations.current;
    if (detail.stage === 'unreviewed' && discoveryApi !== undefined && detail.cloudLinked && !detail.optedOut) {
      void readBrief().then(value => {
        if (active.current && generation === epoch.current) { setBrief(value); setReadFailed(false); }
      }, () => { if (active.current && generation === epoch.current) setReadFailed(true); });
    }
    return () => { active.current = false; epoch.current++; [...cancels].forEach(cancel => cancel()); };
    // Refreshing a detail must not reset the command or remount the draft.
  }, [api, discoveryApi, record, readBrief]);

  useEffect(() => {
    if (record.waitUntil === undefined || !noContacts(detail)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (disposed || !callbacks.current.isSelected()) return;
      if (Date.now() >= record.waitUntil!) {
        record.message = 'Contact results are still unconfirmed. The request is retained. Returning to this window checks for updates, not another lookup.';
        redraw(value => value + 1); return;
      }
      try { await bounded(callbacks.current.readDetail()); } catch { /* Retain the waiting state, never retry lookup. */ }
      if (!disposed && callbacks.current.isSelected()) timer = setTimeout(() => { void tick(); }, 30_000);
    };
    timer = setTimeout(() => { void tick(); }, 5_000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [bounded, detail.personId, detail.salesCycleId, detail.phones.length, detail.emails.length, record, record.waitUntil]);

  const run = async () => {
    if (record.busy || record.lookup !== undefined || !isSelected() || detail.optedOut || !detail.cloudLinked) return;
    record.busy = true; record.message = 'Preparing contact options…'; redraw(value => value + 1);
    const generation = epoch.current;
    const current = () => active.current && generation === epoch.current && isSelected();
    let phase: 'read' | 'prepare' | 'lookup' = 'read';
    try {
      if (record.request !== undefined && record.prepared === undefined || detail.stage === 'unreviewed' && record.prepared === undefined) {
        if (record.request === undefined) {
          const latest = await readBrief();
          if (!current()) return;
          setBrief(latest);
          if (!supportsContactPreparation(latest)) {
            record.message = 'Current evidence does not support contact lookup. A fresh supported identity and Medium or High Fit are required.';
            return;
          }
          record.request = Object.freeze(beginDiscoveryRequestSchema.parse({ commandId: crypto.randomUUID(), personId: detail.personId,
            salesCycleId: detail.salesCycleId, assessmentId: latest.assessment!.id, expectedFingerprint: latest.assessment!.fingerprint }));
        }
        if (!current() || discoveryApi === undefined) return;
        phase = 'prepare';
        const request = record.request;
        const receipt = beginDiscoveryReceiptSchema.parse(await bounded(discoveryApi.begin({ ...request })));
        if (receipt.personId !== request.personId || receipt.salesCycleId !== request.salesCycleId || receipt.assessmentId !== request.assessmentId) throw new Error('Mismatched preparation');
        record.prepared = receipt;
        if (!current()) return;
        window.dispatchEvent(new Event('callie:contact-prepared'));
      }
      phase = 'read';
      const fresh = await bounded(readDetail());
      if (!current()) return;
      if (fresh === null) { record.message = 'Contact selection changed. No lookup was requested.'; return; }
      if (!noContacts(fresh)) { record.message = 'Contact options are now available.'; return; }
      if (!fresh.findContactEligibility.eligible) {
        record.message = fresh.findContactEligibility.refusalReason === null ? 'Contact lookup is unavailable.' : FIND_CONTACT_RECEIPTS[fresh.findContactEligibility.refusalReason];
        return;
      }
      // No await between the final owner fence and this explicit lookup.
      phase = 'lookup'; record.lookup = 'pending'; record.message = 'Requesting contact info…'; redraw(value => value + 1);
      const result = findContactInfoReceiptSchema.parse(await bounded(api.findContactInfo({ personId: detail.personId }), 65_000));
      if (result.written && result.refusalReason !== null) throw new Error('Contradictory lookup receipt');
      record.lookup = result.written ? 'written' : undefined;
      record.message = result.written ? FIND_CONTACT_RECEIPTS.written : result.refusalReason === null ? 'The request was not submitted.' : FIND_CONTACT_RECEIPTS[result.refusalReason];
      if (result.written) record.waitUntil = Date.now() + PENDING_HORIZON_MS;
    } catch (error) {
      if (phase === 'prepare') {
        if (staleDiscoveryError(error)) {
          record.request = undefined;
          record.message = 'Evidence changed. Check current evidence before choosing contact lookup again.';
          if (current()) void readBrief().then(value => { if (current()) setBrief(value); }, (): undefined => undefined);
        } else record.message = 'Preparation response unavailable. Your request is retained. Choose Find contact info explicitly to check the same request.';
      } else if (phase === 'lookup') {
        record.lookup = 'uncertain'; record.waitUntil = Date.now() + PENDING_HORIZON_MS;
        record.message = 'Contact request response unavailable. It may have been submitted. Waiting for sync, without another lookup.';
      } else record.message = 'Current contact evidence could not load. No lookup was requested. Try Find contact info again.';
    } finally {
      record.busy = false;
      if (current()) redraw(value => value + 1);
    }
  };
  const candidate = detail.stage === 'unreviewed' && detail.workflowStatus === 'active' && brief !== null && supportsContactPreparation(brief);
  const allowed = !detail.optedOut && detail.cloudLinked && (detail.findContactEligibility.eligible || candidate || record.request !== undefined);
  const reason = detail.optedOut ? FIND_CONTACT_RECEIPTS.suppression_blocked : !detail.cloudLinked ? FIND_CONTACT_RECEIPTS.identity_or_address_missing
    : detail.stage === 'unreviewed' && !candidate && record.request === undefined
      ? readFailed ? 'Contact evidence could not load. Reopen this person to check again.' : brief === null ? 'Checking contact preparation evidence…' : 'Current evidence does not support contact lookup. A fresh supported identity and Medium or High Fit are required.'
      : !allowed && detail.findContactEligibility.refusalReason !== null ? FIND_CONTACT_RECEIPTS[detail.findContactEligibility.refusalReason] : null;
  return <div className="lead-inspector__find-contact">
    <Button variant="quiet" disabled={!allowed || record.busy || record.lookup !== undefined} onClick={() => { void run(); }}>Find contact info</Button>
    {(record.message ?? reason) !== null && <p role="status">{record.message ?? reason}</p>}
  </div>;
}
