import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {CRM_MAIL_CAPTURE_CONSENT,CRM_OWNER_SCOPE_VERSION,type crmMailCaptureControlsSaveSchema} from "@fss/contracts";
import { operations } from "../app/bridges.ts";
import type { z } from "zod";
import type { crmCapabilityReadResponseSchema,CrmOwnerApproval } from "@fss/contracts";
export type Capability =
  "metadata_review" | "mail_capture" | "crm_extraction";
export interface CapabilityTarget {
  capability: Capability;
  mailboxId?: string;
  purpose?: "answer"|"embedding";
}
export interface CapabilityChange {
  revision: number;
  enabled: boolean;
  authorityReceiptId: string | null;
}
export interface CrmCapabilityPorts {
  prepareCapture?(input:Omit<z.infer<typeof crmMailCaptureControlsSaveSchema>,"commandId"|"clientVersion">):Promise<{revision:number;enabled:false}>;
  read(
    input: CapabilityTarget,
  ): Promise<z.infer<typeof crmCapabilityReadResponseSchema>>;
  activate(
    input: CapabilityTarget & {
      expectedRevision: number;
      approval: CrmOwnerApproval;
    },
  ): Promise<CapabilityChange>;
  disable(
    input: CapabilityTarget & { expectedRevision: number },
  ): Promise<CapabilityChange>;
}

const descriptions = {
  metadata_review: {
    name: "metadata review",
    detail:
      "Retain business email metadata for your private review. This does not copy message bodies.",
  },
  mail_capture: {
    name: "original email capture",
    detail:
      "Copy approved business incoming and Sent originals from activation forward only. No older backfill. Personal, excluded and unresolved mail stays excluded. Hosted AI requires separate approval.",
  },
  crm_extraction: {
    name: "evidence extraction",
    detail:
      "Use separately approved hosted AI for mail only, bound to the current capture approval. Notes, call and meeting transcripts are not authorized. Source ownership, deletion and spending limits still apply.",
  },
} as const;
function api() {
  const value = operations();
  if (!value) throw new Error("unavailable");
  return value;
}
export const crmCapabilityPorts: CrmCapabilityPorts = {
  prepareCapture:input=>api().command("crm.mailCapturePrepare",input),
  read: (input) => api().read("crm.capabilityRead", {...input,scopeVersion:CRM_OWNER_SCOPE_VERSION}),
  activate: (input) => {
    switch (input.capability) {
      case "metadata_review":
        return api().command("crm.metadataReviewActivate", {
          ...input,
          capability: "metadata_review",
        });
      case "mail_capture":
        return api().command("crm.mailCaptureActivate", {
          ...input,
          capability: "mail_capture",
          scopeVersion:CRM_OWNER_SCOPE_VERSION,
        });
      case "crm_extraction":
        return api().command("crm.extractionActivate", {
          ...input,
          capability: "crm_extraction",
          scopeVersion:CRM_OWNER_SCOPE_VERSION,
        });
    }
  },
  disable: (input) => {
    switch (input.capability) {
      case "metadata_review":
        return api().command("crm.metadataReviewDisable", {
          ...input,
          capability: "metadata_review",
        });
      case "mail_capture":
        return api().command("crm.mailCaptureDisable", {
          ...input,
          capability: "mail_capture",
        });
      case "crm_extraction":
        return api().command("crm.extractionDisable", {
          ...input,
          capability: "crm_extraction",
        });
    }
  },
};
type View = z.infer<typeof crmCapabilityReadResponseSchema>;
type Snapshot = { key: string; rows: Partial<Record<Capability, View>> };
export function CrmCapabilitiesSection({
  scope,
  available,
  privacyKey,
  mailboxId,
  ports = crmCapabilityPorts,
  refreshVersion = 0,
  onChange,
}: {
  scope: "mail" | "ai";
  available: boolean;
  privacyKey: string;
  mailboxId?: string;
  ports?: CrmCapabilityPorts;
  refreshVersion?: number;
  onChange?: () => void;
}) {
  const targets = useMemo<CapabilityTarget[]>(
    () =>
      scope === "ai"
        ? [{ capability: "crm_extraction" }]
        : mailboxId
          ? [
              { capability: "metadata_review", mailboxId },
              { capability: "mail_capture", mailboxId },
            ]
          : [],
    [scope, mailboxId],
  );
  const key = `${privacyKey}:${scope}:${mailboxId ?? ""}`;
  const latest = useRef({ key, available });
  latest.current = { key, available };
  const issuance = useRef(0);
  const [reviews,setReviews]=useState<Partial<Record<Capability,{reference:string;critical:boolean;integration:boolean}>>>({});
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [busy, setBusy] = useState<Capability | null>(null),
    [error, setError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const current = useCallback(
    (ticket: number) =>
      issuance.current === ticket &&
      latest.current.key === key &&
      latest.current.available,
    [key],
  );
  const readTargets = useCallback(async () => {
    const results = await Promise.allSettled(
      targets.map(async (target) => ports.read(target)),
    );
    const rows: Partial<Record<Capability, View>> = {};
    results.forEach((result, index) => {
      const target = targets[index];
      if (
        target &&
        result.status === "fulfilled" &&
        result.value.capability === target.capability &&
        result.value.mailboxId === (target.mailboxId ?? null)
      )
        rows[target.capability] = result.value;
    });
    return rows;
  }, [ports, targets]);
  useEffect(() => {
    const sequence = issuance;
    const ticket = ++sequence.current;
    setSnapshot(null);
    setReviews({});
    setBusy(null);
    setError(null);
    void refresh;
    void refreshVersion;
    if (available)
      void readTargets().then((rows) => {
        if (current(ticket)) {
          setSnapshot({ key, rows });
          if (Object.keys(rows).length !== targets.length)
            setError(
              "Some controls could not be checked. Refresh before activating.",
            );
        }
      });
    return () => {
      sequence.current++;
    };
  }, [available, key, current, readTargets, targets, refresh, refreshVersion]);
  async function perform(target: CapabilityTarget, view: View) {
    if (!available || busy !== null || snapshot?.key !== key) return;
    if (!view.enabled && !view.ready)
      return;
    if(!view.enabled&&target.capability!=='metadata_review'&&view.scopeVersion!==CRM_OWNER_SCOPE_VERSION)return;
    if(!view.enabled&&(target.capability==='crm_extraction')){
      const review=reviews[target.capability];if(!review?.critical||!review.integration||!review.reference.trim())return;
    }
    const ticket = ++issuance.current;
    setBusy(target.capability);
    setError(null);
    try {
      if (view.enabled)
        await ports.disable({ ...target, expectedRevision: view.revision });
      else
        await ports.activate({
          ...target,
          expectedRevision: view.revision,
          approval: target.capability==='crm_extraction'?{
            consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,
            reviewedEvaluationReference:reviews[target.capability]?.reference??'',limitations:['representative_quality_unverified'],
          }:{consentAcknowledged:true,qualityTier:'acquisition',limitations:[]},
        });
      if (!current(ticket)) return;
      const rows = await readTargets();
      if (!current(ticket)) return;
      setSnapshot({ key, rows });
      onChange?.();
      if (Object.keys(rows).length !== targets.length)
        setError(
          "Saved, but some current controls could not be checked. Refresh before another action.",
        );
    } catch {
      if (current(ticket)) {
        setSnapshot(null);
        setError(
          "The action could not be confirmed. Refresh before another action.",
        );
      }
    } finally {
      if (current(ticket)) setBusy(null);
    }
  }
  async function prepareCapture(){
    const metadata=snapshot?.key===key?snapshot.rows.metadata_review:undefined;
    const capture=snapshot?.key===key?snapshot.rows.mail_capture:undefined;
    const c=metadata?.configuration;
    if(!ports.prepareCapture||!c||c.capability!=='metadata_review'||busy||!available)return;
    const ticket=++issuance.current;setBusy('mail_capture');setError(null);
    try{await ports.prepareCapture({mailboxId:c.mailboxId,expectedRevision:capture?.revision??0,expectedGeneration:c.generation,expectedAccountBinding:c.accountBinding,policyRevision:c.revision,disclosureVersion:CRM_MAIL_CAPTURE_CONSENT.version,disclosureSha256:CRM_MAIL_CAPTURE_CONSENT.sha256});
      if(!current(ticket))return;const rows=await readTargets();if(current(ticket)){setSnapshot({key,rows});onChange?.();}
    }catch{if(current(ticket))setError('Capture preparation could not be confirmed. Refresh before another action.');}finally{if(current(ticket))setBusy(null);}
  }
  const rows = snapshot?.key === key ? snapshot.rows : {};
  if (!available) return null;
  return (
    <section
      aria-label={
        scope === "mail"
          ? "Business email controls"
          : "Evidence controls"
      }
    >
      <h3>{scope === "mail" ? "Business email" : "Evidence"}</h3>
      <p>
        These controls do not authorize sending or change sending safeguards.
      </p>
      {scope === "mail" && !mailboxId ? (
        <p>Connect your own mailbox to prepare conversation capture.</p>
      ) : null}
      {scope==='mail'&&ports.prepareCapture&&rows.metadata_review?.configuration?<><p>{CRM_MAIL_CAPTURE_CONSENT.text}</p><button type="button" disabled={busy!==null} onClick={()=>void prepareCapture()}>Prepare original email capture (stays off)</button></>:null}
      {targets.map((target) => {
        const description = descriptions[target.capability],
          view = rows[target.capability];
        const active = view?.enabled === true;
        const ai=target.capability==='crm_extraction';
        const review=reviews[target.capability]??{reference:'',critical:false,integration:false};
        const updateReview=(patch:Partial<typeof review>)=>setReviews(old=>({...old,[target.capability]:{...review,...patch}}));
        return (
          <article key={target.capability}>
            <h4>
              {description.name[0]!.toUpperCase() + description.name.slice(1)}
            </h4>
            <p>{description.detail}</p>
            <p>
              {!view
                ? "Current availability has not been verified."
                : active
                  ? view.ready
                    ? "On."
                    : "On, but processing is blocked until current verification passes."
                  : !view.configured
                    ? "Not prepared. Save your account, provider and budget settings first."
                    : view.ready
                      ? "Ready for your explicit scope approval."
                      : "Off. Current verification is still required."}
            </p>
            {view?.configuration?<p>Owner: {view.configuration.ownerUserId}. {"mailboxId" in view.configuration?`Mailbox: ${view.configuration.providerAccountId}.`:`Provider: ${view.configuration.endpointId}; model: ${view.configuration.modelVersion}; daily budget: ${view.configuration.dailyCeilingCents} cents; monthly budget: ${view.configuration.monthlyCeilingCents} cents.`}</p>:null}
            {view?.configuration?.capability==='mail_capture'&&view.configuration.forwardScope?<p>Forward-only original cutoff: {view.configuration.forwardScope.enabledAt}. Incoming and Sent use the same cutoff; restart does not move it.</p>:null}
            {view?.configuration?.capability==='crm_extraction'?<p>Allowed originals: mail only when current capture approval matches {view.configuration.mailCaptureOwnerApprovalId??'unconfigured'}. No native transcript or note processing authority.</p>:null}
            {view?.configuration&&'endpointId' in view.configuration?<>
              <p>Purpose: conversation evidence extraction.</p>
              <p>Access approval version: {view.configuration.accessGrantVersion}.</p>
              <p>Data handling version: {view.configuration.dataHandlingVersion}. This is the configured policy for data sent to the displayed provider; review its retention and permitted use before approving.</p>
            </>:null}
            {view?.configuration&&'disclosureVersion' in view.configuration?<p>Capture disclosure version: {view.configuration.disclosureVersion}. The current scope is bound to this disclosure and mailbox generation.</p>:null}
            {view?.limitations.length?<ul aria-label="Evaluation limitations">{view.limitations.map(limit=><li key={limit}>{limit==='limited_business_examples'?'Limited business examples; broader business quality remains unmeasured.':limit==='vector_quality_unverified'?'Vector quality remains unverified.':'Representative business quality remains unverified.'}</li>)}</ul>:null}
            {view?.qualityTier==='provisional_owner'?<p>Provisional owner-only quality. Representative business quality remains unverified; review outputs and corrections during use.</p>:null}
            {ai&&!active&&view?.configured?<fieldset><legend>Review before enabling {description.name}</legend>
              <label>Reviewed evaluation reference<input value={review.reference} maxLength={200} onChange={event=>updateReview({reference:event.target.value})}/></label>
              <label><input type="checkbox" checked={review.critical} onChange={event=>updateReview({critical:event.target.checked})}/>Critical access, deletion and safety checks passed</label>
              <label><input type="checkbox" checked={review.integration} onChange={event=>updateReview({integration:event.target.checked})}/>Actual configured model integration was verified</label>
              <p>Approval covers your configured source access, provider/data handling, purpose/model and spending limits. Quality is provisional; this does not authorize other users or outreach.</p>
            </fieldset>:null}
            <button
              type="button"
              disabled={
                busy !== null ||
                !view ||
                (!active && (!view.ready||target.capability!=='metadata_review'&&view.scopeVersion!==CRM_OWNER_SCOPE_VERSION||ai&&(!review.critical||!review.integration||!review.reference.trim())))
              }
              onClick={() => {
                if (view) void perform(target, view);
              }}
            >
              {active ? "Disable" : "Activate"} {description.name}
            </button>
          </article>
        );
      })}
      {error ? <p role="alert">{error}</p> : null}
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh controls
      </button>
    </section>
  );
}
