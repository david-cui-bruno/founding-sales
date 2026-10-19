import type {TableCoverage} from './coverage.ts';

/** Sourcing content follows candidate deletion. Accounting deliberately survives. */
export const SOURCING_RETENTION_COVERAGE:Readonly<Record<string,TableCoverage>>={
 sourcing_search_account:{dispositions:['operational'],note:'Shared Tavily search allowance and halt state; no credential material.'},
 sourcing_discovery_settings:{dispositions:['operational'],note:'Workspace discovery schedule and status.'},
 sourcing_discovery_attempts:{dispositions:['retained'],note:'Search dispatch and quota history, containing fixed queries only; required to prevent replay.'},
 sourcing_discovery_hits:{dispositions:['retained'],note:'Public source URL deduplication tombstones; kept after candidate deletion to prevent rediscovery.'},
 sourcing_qualification_runs:{dispositions:['deletion_removes'],note:'Bounded candidate evidence and interpretations cascade on candidate deletion. Provider accounting remains independent.'},
 sourcing_feedback:{dispositions:['retained'],note:'Versioned sourcing feedback; removed with candidate evidence by cascading deletion.'},
 sourcing_admissions:{dispositions:['deletion_removes'],note:'Candidate-to-CRM provenance cascades with candidate evidence; deleting it does not delete a CRM firm or undo a stop.'},
 sourcing_candidates:{dispositions:['deletion_removes'],note:'Independent unverified drafts; the admin candidate delete command removes the payload. No CRM contact or firm is created.'},
 sourcing_apollo_allowances:{dispositions:['operational','retained'],note:'Nonsecret opaque exclusive-account/key references, verified Free cycle/prior usage and conserved allowance/halt history. No credential values or prospect data. Explicit operator configuration only, current binding/clock and research authority gate dispatch. Retain through candidate deletion and owner departure to prevent quota reset; historical configuration never grants sending or first-party qualification authority.'},
 sourcing_apollo_attempts:{dispositions:['retained'],note:'Body-free local opaque page/attempt identities and counters survive candidate deletion and departure to conserve spent and uncertain credits and prevent replay. No company names, contact fields, vendor raw payloads or credential material. New-cycle configuration refuses unreconciled unknown/failed attempts. Current workspace/account/key/research checks gate new dispatch.'},
 sourcing_apollo_candidate_origins:{dispositions:['deletion_removes'],note:'Only company name, domain, HQ city/state, size and opaque local attempt/revision provenance. Candidate deletion cascades every origin row. No person/contact fields or vendor raw payload. No new retention sweep: provenance shares the existing candidate lifecycle, while separate body-free attempts conserve quota after erasure. Owner departure invalidates existing qualification authority through membership checks; origin cannot authorize first-party claims or outreach.'},
};
