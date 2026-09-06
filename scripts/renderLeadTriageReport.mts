import {
  closeSync, constants, fchmodSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  assertTriageArtifactSafe,
  leadTriageAssessmentSchema,
  leadTriageSnapshotSchema,
  triageRecommendationSchema,
  type LeadTriageAssessment,
  type LeadTriageEvidence,
  type LeadTriageSnapshot,
  type TriageEvidenceCode,
} from '../src/shared/contracts/leadTriageReportContract.ts';

const TRIAGE_EVIDENCE_LABELS: Record<TriageEvidenceCode, string> = {
  organization_property_match: 'Organization property match',
  organization_residence_match: 'Organization residence match',
  organization_business_match: 'Organization business match',
  organization_relationship_unknown: 'Organization relationship unknown',
  fit_low: 'Low Fit',
  fit_medium: 'Medium Fit',
  fit_high: 'High Fit',
  fit_evidence_missing: 'Fit evidence missing',
  timing_trigger_active: 'Active timing trigger',
  timing_trigger_stale: 'Stale timing trigger',
  timing_evidence_missing: 'Timing evidence missing',
  cloud_signal_present: 'Cloud signal present',
  direct_contact_present: 'Direct contact present',
  no_usable_direct_contact: 'No usable direct contact',
  contact_validation_unknown: 'Contact validation unknown',
  contact_validation_invalid: 'Contact validation invalid',
  contact_ownership_unverified: 'Contact ownership unverified',
  compliance_clear: 'Compliance verified clear',
  compliance_blocked: 'Compliance blocked',
  compliance_unknown: 'Compliance unknown',
  identity_collision: 'Identity collision',
  identity_relationship_unknown: 'Identity relationship unknown',
  identity_address_missing: 'Identity address missing',
  enrichment_rate_limited: 'Enrichment rate limited',
};
const RECOMMENDATION_LABELS: Record<LeadTriageAssessment['recommendation'], string> = {
  ready_candidate: 'Ready candidate', needs_identity: 'Needs identity',
  needs_compliance: 'Needs compliance', needs_contact: 'Needs contact',
  watch: 'Watch', dismiss_candidate: 'Dismiss candidate',
};
const COMPLIANCE_LABELS: Record<LeadTriageEvidence['compliance']['status'], string> = {
  verified_clear: 'Verified clear', blocked: 'Blocked', unknown: 'Unknown', mixed: 'Mixed',
};
const inputSchema = z.object({
  snapshot: leadTriageSnapshotSchema,
  assessments: z.array(leadTriageAssessmentSchema),
}).strict();

// Only free-form labels/identifiers use this. Closed codes are not provider prose.
// Entities prevent table/HTML/autolink syntax; backslashes neutralize Markdown.
function text(value: string | null): string {
  if (value === null) return 'Unknown';
  const display = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ');
  // Screen visible text before escape characters can conceal an existing match.
  assertTriageArtifactSafe(display);
  const entities: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '|': '&#124;', ':': '&#58;',
  };
  return display
    .replace(/[\\`*_{}[\]()#+.!~-]/g, '\\$&')
    .replace(/[&<>|:]/g, (character) => entities[character]);
}
function number(value: number | null): string { return value === null ? 'Unknown' : String(value); }
function band(value: string | null): string { return value === null ? 'Unknown' : value[0].toUpperCase() + value.slice(1); }
function evidence(codes: readonly TriageEvidenceCode[], absent = 'Unknown'): string {
  return codes.length ? codes.map((code) => `${code} (${TRIAGE_EVIDENCE_LABELS[code]})`).join(', ') : absent;
}
function identity(lead: LeadTriageEvidence): string {
  return `${text(lead.personName)} (person: ${text(lead.personId)}, cycle: ${text(lead.salesCycleId)})`;
}
function reference(lead: LeadTriageEvidence): string { return `Rank ${lead.rank}: ${identity(lead)}`; }
function key(value: { personId: string; salesCycleId: string }): string {
  return JSON.stringify([value.personId, value.salesCycleId]);
}
function refusals(lead: LeadTriageEvidence): string {
  return lead.compliance.refusalReasonCodes.join(', ')
    || (lead.compliance.status === 'verified_clear' ? 'None reported' : 'Unknown');
}
function details(lead: LeadTriageEvidence, assessment: LeadTriageAssessment): string {
  return [
    `Assessment: ${evidence(assessment.evidenceCodes)}`,
    `Locality: ${text([lead.locality, lead.region, lead.postalCode].map((part) => part ?? 'Unknown').join(' '))}`,
    `Organization: ${text(lead.organization.label)}, relationship: ${lead.organization.relationship ?? 'Unknown'}`,
    `Organization evidence: ${evidence(lead.organization.evidenceCodes)}`,
    `Fit evidence: ${evidence(lead.fit.evidenceCodes)}`,
    `Triggers: ${lead.timing.triggers.map((trigger) => `${trigger.code} observed ${trigger.observedAt}, expires ${trigger.expiresAt ?? 'Unknown'}`).join(', ') || 'Unknown'}`,
    `Cloud Fit: ${number(lead.cloud.fit)}`,
    `Cloud Timing: ${number(lead.cloud.timing)}`,
    `Cloud contributions: ${lead.cloud.contributions.map((entry) => `${entry.signalCode}: ${entry.contribution}`).join(', ') || 'Unknown'}`,
    `Contacts: ${lead.contacts.phoneCount} phones, ${lead.contacts.emailCount} emails, ${lead.contacts.usableDirectCount} usable direct`,
    `Primary candidate: ${text(lead.contacts.maskedPrimaryPhone)}`,
    `Contact evidence: ${evidence(lead.contacts.evidenceCodes)}`,
    `Refusal codes: ${refusals(lead)}`,
    `Identity: ${evidence(lead.identityConcernCodes, 'None reported')}`,
  ].join('; ');
}
function section(title: string, rows: string[]): string {
  return `## ${title}\n\n${rows.length ? rows.join('\n') : '- None reported.'}`;
}

/** Pure, deterministic presentation of supplied assessments. No scoring or actions. */
export function buildLeadTriageReport(input: {
  snapshot: LeadTriageSnapshot;
  assessments: readonly LeadTriageAssessment[];
}): string {
  try {
    // Scan raw input too: parsing/escaping must not discard or disguise unsafe text.
    assertTriageArtifactSafe(input);
    const { snapshot, assessments } = inputSchema.parse(input);
    const byKey = new Map(assessments.map((assessment) => [key(assessment), assessment]));
    if (byKey.size !== assessments.length || assessments.length !== snapshot.leads.length) throw new Error();
    const entries = snapshot.leads.map((lead) => {
      const assessment = byKey.get(key(lead));
      // The frozen report field is whole points, never persisted millipoints.
      if (!assessment || (lead.timing.value !== null && (lead.timing.value < 0 || lead.timing.value > 40))) throw new Error();
      return { lead, assessment };
    });
    const table = [
      '| Rank | Lead | Fit | Timing | Reachability | Confidence | Compliance | Recommendation | Evidence codes |',
      '|---|---|---|---|---|---|---|---|---|',
      ...entries.map(({ lead, assessment }) => `| ${[
        lead.rank, identity(lead), `${band(lead.fit.band)} ${number(lead.fit.points)}/30`,
        `${band(lead.timing.band)} ${number(lead.timing.value)}/40`, band(lead.reachability),
        `${number(lead.dataConfidence)}/10`, COMPLIANCE_LABELS[lead.compliance.status],
        assessment.recommendation, details(lead, assessment),
      ].join(' | ')} |`),
    ].join('\n');
    const priority = (value: 'P0' | 'P1') => entries.filter(({ assessment }) => assessment.likelyPriority === value)
      .map(({ lead, assessment }) => `- ${reference(lead)}. Evidence: ${evidence(assessment.evidenceCodes)}`);
    const markdown = [
      '# Top 30 Unreviewed Lead Triage',
      `Generated: \`${new Date(snapshot.generatedAt).toISOString()}\`\nQueue ordering: standard application triage ordering\nState changes: none\nSnapshot revision: \`${snapshot.revisionBefore}\` → \`${snapshot.revisionAfter}\`\nDistinct people: \`${entries.length}\`\nQueue rows scanned: \`${snapshot.scannedQueueRows}\``,
      `## Recommendations\n\n${table}`,
      section('Counts by recommendation', triageRecommendationSchema.options.map((recommendation) =>
        `- ${RECOMMENDATION_LABELS[recommendation]}: ${assessments.filter((assessment) => assessment.recommendation === recommendation).length}`)),
      section('Likely P0 candidates', priority('P0')),
      section('Likely P1 candidates', priority('P1')),
      section('Blocked by compliance', entries.filter(({ lead }) => lead.compliance.status !== 'verified_clear')
        .map(({ lead }) => `- ${reference(lead)}. ${COMPLIANCE_LABELS[lead.compliance.status]}. Refusal codes: ${refusals(lead)}`)),
      section('Needs identity repair', entries.filter(({ lead, assessment }) => lead.identityConcernCodes.length || assessment.recommendation === 'needs_identity')
        .map(({ lead }) => `- ${reference(lead)}. Identity: ${evidence(lead.identityConcernCodes)}`)),
      section('Suggested founder review order', [...entries]
        .sort((a, b) => a.assessment.suggestedReviewOrder - b.assessment.suggestedReviewOrder || a.lead.rank - b.lead.rank)
        .map(({ lead, assessment }, index) => `${index + 1}. ${reference(lead)}. ${assessment.recommendation}. Evidence: ${evidence(assessment.evidenceCodes)}`)),
    ].join('\n\n') + '\n';
    assertTriageArtifactSafe(markdown);
    return markdown;
  } catch {
    // Do not return native/schema errors, paths, keys or input payloads.
    throw new Error('Invalid triage report input.');
  }
}

function argumentsForCli(args: string[]): { snapshot: string; assessments: string; output: string } {
  if (args.length !== 6) throw new Error();
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--snapshot', '--assessments', '--output'].includes(name)
      || options.has(name) || !value || value.startsWith('--')) throw new Error();
    options.set(name, resolve(value));
  }
  return { snapshot: options.get('--snapshot')!, assessments: options.get('--assessments')!, output: options.get('--output')! };
}
function inside(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function outputDestination(output: string): string {
  // Derive boundaries only from this module's installation, never cwd or a crawl.
  const checkout = realpathSync(new URL('../', import.meta.url));
  // Also exclude the hosting checkout for this repository's .worktrees layout.
  const repository = checkout.split(`${sep}.worktrees${sep}`)[0];
  const destination = join(realpathSync(dirname(output)), basename(output));
  if ([checkout, repository].some((root) => inside(root, output) || inside(root, destination))
    || lstatSync(destination, { throwIfNoEntry: false })) throw new Error();
  return destination;
}
function main(): void {
  try {
    const paths = argumentsForCli(process.argv.slice(2));
    const markdown = buildLeadTriageReport({
      snapshot: JSON.parse(readFileSync(paths.snapshot, 'utf8')),
      assessments: JSON.parse(readFileSync(paths.assessments, 'utf8')),
    });
    // All schema, raw/final privacy and destination validation precede this open.
    const destination = outputDestination(paths.output);
    // Existing inputs, hardlinks, files and final symlinks all fail exclusively.
    // No mkdir. Parent resolution is not protection against a hostile same-UID race.
    const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, markdown, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    process.stderr.write('Unable to render triage report.\n');
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
