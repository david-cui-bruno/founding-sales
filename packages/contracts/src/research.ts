import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of research (`.context/DECISION-20260928-crm-design.md`,
 * "Research"; David's answers 5 and 8).
 *
 * POSTs, including the reads, for the reason `crmSurface.ts` gives: a firm id in a
 * query string is written to a load balancer's access log and quoted back in an
 * error page, and section 14.1 asks for redacted responses.
 *
 * Every response DTO here is a `z.object` rather than a `z.strictObject`. A key an
 * installed desktop does not know is stripped by its parser rather than refusing the
 * whole answer, which is what lets the API be deployed ahead of the Macs it serves
 * (`wire.ts`). The firm page's own `z.strictObject` behind `pageVersion` is the
 * exception, and this lane does not touch it: the desktop's Research section reads
 * these routes instead.
 */

export const RESEARCH_JUDGMENT_VALUES = ['yes', 'no', 'unknown'] as const;
export const researchJudgmentSchema = z.enum(RESEARCH_JUDGMENT_VALUES);
export type ResearchJudgmentValue = z.infer<typeof researchJudgmentSchema>;

/**
 * The fact keys a run may record. A closed set on the wire as well as in the
 * database, so a desktop can lay them out by name without guessing.
 */
export const RESEARCH_FACT_KEYS = [
  'ownership',
  'portfolio_description',
  'portfolio_size',
  'residential_scope',
  'operating_footprint',
  'maintenance_workflow',
  'software_evidence',
  'hiring_maintenance',
  'phone_listed',
  'role',
  'named_role',
  'recent_change',
  'target_fit',
  'not_target',
] as const;

export const RESEARCH_TRIGGERS = ['firm_created', 'sweep', 'user_request', 'link_added'] as const;
export const RESEARCH_OUTCOMES = ['running', 'completed', 'refused', 'failed'] as const;

/**
 * Every refusal a research route can answer. On the wire so the desktop has one
 * place to find the words for each, and so a code that disappears is a contract
 * change rather than a silent blank.
 */
export const RESEARCH_REFUSAL_CODES = [
  'invalid_input',
  'research_disabled',
  'daily_firm_ceiling',
  'daily_cost_ceiling',
  'monthly_cost_ceiling',
  'ceiling_reached',
  'firm_unknown',
  'firm_merged',
  'firm_suppressed',
  'not_assigned',
  'admin_only',
  'run_in_progress',
  'no_sources',
  'provider_failure',
  /** A worker vanished between the run's two chunks; the sweep closed the run. */
  'lease_lost',
  'link_not_permitted',
  'model_unpriced',
] as const;

/**
 * One quote, with the source it came from, when it was read, and whose words they are.
 *
 * `firstParty` is false for a page on a host that is not the firm's own — a link
 * somebody added — and `attribution` is the line to render beside it ("per news.test").
 * Without the pair, the brief would present a trade article's sentence as something the
 * firm said, which is precisely the distinction the design record asks the brief to
 * keep.
 */
export const briefQuoteSchema = z.object({
  quote: z.string().min(1).max(500),
  sourceReference: z.string().min(1).max(500),
  retrievedAt: instant,
  firstParty: z.boolean(),
  attribution: z.string().min(1).max(200).nullable(),
});

/**
 * The call brief.
 *
 * `whyFit` and `whatChanged` are the firm's own words. `questions` and `opening` are
 * written by a model and `generated` is true whenever either is present — the desktop
 * labels those two, and only those two, "AI suggestion".
 */
export const callBriefSchema = z.object({
  whyFit: z.array(briefQuoteSchema).max(3),
  whatChanged: z.array(briefQuoteSchema).max(2),
  likelyPerson: z
    .object({ contactId: uuid, name: z.string().min(1).max(200), title: z.string().max(200).nullable() })
    .nullable(),
  questions: z.tuple([z.string().min(1).max(500), z.string().min(1).max(500)]).nullable(),
  opening: z.string().min(1).max(1000).nullable(),
  generated: z.boolean(),
  judgments: z.object({
    fit: researchJudgmentSchema,
    problemEvidence: researchJudgmentSchema,
    timing: researchJudgmentSchema,
    reachability: researchJudgmentSchema,
  }),
  judgedAt: instant,
  revision: z.number().int().min(0),
  sources: z.array(z.object({ sourceReference: z.string().min(1).max(500), retrievedAt: instant })),
  /**
   * Failed runs since the last completed one, so the firm page can say "research
   * failed, N tries" rather than showing a brief that is quietly out of date. Three is
   * where the sweep stops trying.
   */
  failedTries: z.number().int().min(0),
});
export type CallBriefDto = z.infer<typeof callBriefSchema>;

/**
 * One recorded fact.
 *
 * `quote` is **null** for `named_role`, `phone_listed` and `role`. Those keys are
 * selected because a block names a person or publishes a number, and a contact-scoped
 * deletion does not reach a firm's rows, so the block is referenced and never copied
 * (`research/facts.ts`, `PERSON_FACT_KEYS`). The fact still counts towards a judgment;
 * it is simply never rendered as a quotation.
 */
export const researchFactSchema = z.object({
  id: uuid,
  key: z.string().min(1).max(40),
  quote: z.string().min(1).max(500).nullable(),
  firstParty: z.boolean(),
  sourceReference: z.string().min(1).max(500),
  retrievedAt: instant,
  confidence: z.number().min(0).max(1).nullable(),
});

export const researchJudgmentsSchema = z.object({
  fit: researchJudgmentSchema,
  problemEvidence: researchJudgmentSchema,
  timing: researchJudgmentSchema,
  reachability: researchJudgmentSchema,
  /** One short sentence per judgment, naming the fact ids it rests on. */
  reasons: z.record(z.string(), z.string().max(300)),
  callFirst: z.boolean(),
  likelyContactId: uuid.nullable(),
  judgedAt: instant,
});

/** Why the model was or was not used. `research_runs_extraction_known` is the same set. */
export const RESEARCH_EXTRACTION_OUTCOMES = ['used', 'unconfigured', 'no_pages', 'failed'] as const;

export const researchRunSchema = z.object({
  revision: z.number().int().min(1),
  trigger: z.enum(RESEARCH_TRIGGERS),
  startedAt: instant,
  completedAt: instant.nullable(),
  outcome: z.enum(RESEARCH_OUTCOMES),
  refusalCode: z.string().max(64).nullable(),
  pagesFetched: z.number().int().min(0),
  factsRecorded: z.number().int().min(0),
  costCents: z.number().int().min(0),
  /**
   * True when `costCents` is the run's **reservation** rather than an invoice.
   *
   * A transport that threw, a response that carried no usage, and a lease lost between
   * the run's two chunks all record what was authorized instead of zero, because zero
   * is the one answer that is certainly wrong about a call that may have been billed.
   */
  costEstimated: z.boolean(),
  extraction: z.enum(RESEARCH_EXTRACTION_OUTCOMES),
});

export const researchLinkSchema = z.object({
  id: uuid,
  url: z.string().min(1).max(500),
  addedByUserId: uuid,
  addedAt: instant,
});

/** Whole cents, both numbers, in the workspace's business zone. */
export const researchSpendSchema = z.object({
  todayCents: z.number().int().min(0),
  monthToDateCents: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// POST /research/firm — the read
// ---------------------------------------------------------------------------

export const researchFirmRequestSchema = z.strictObject({ firmId: uuid });

export const researchFirmResponseSchema = z.object({
  brief: callBriefSchema.nullable(),
  facts: z.array(researchFactSchema),
  judgments: researchJudgmentsSchema.nullable(),
  runs: z.array(researchRunSchema).max(5),
  links: z.array(researchLinkSchema),
  spend: researchSpendSchema,
});
export type ResearchFirmResponse = z.infer<typeof researchFirmResponseSchema>;

// ---------------------------------------------------------------------------
// The three commands
// ---------------------------------------------------------------------------

export const researchRunCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firmId: uuid,
});

export const researchRunResultSchema = z.object({
  revision: z.number().int().min(1),
  /** False when a job for this revision was already queued. Not an error. */
  queued: z.boolean(),
});

export const researchAddLinkCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  firmId: uuid,
  /** https only. `firm_links_url_shape` and `isPublicResearchUrl` both refuse the rest. */
  url: z.string().min(8).max(500),
});

export const researchAddLinkResultSchema = z.object({
  link: researchLinkSchema,
  /** The revision the link triggered, or null when the enqueue refused. */
  revision: z.number().int().min(1).nullable(),
});

/** The only model a run may use: the one `pricing.ts` has a reviewed price row for. */
export const RESEARCH_MODELS = ['claude-haiku-4-5'] as const;

export const researchSettingsCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  enabled: z.boolean().optional(),
  dailyFirmCeiling: z.number().int().min(0).max(10_000).optional(),
  dailyCostCeilingCents: z.number().int().min(0).max(1_000_000).optional(),
  monthlyCostCeilingCents: z.number().int().min(0).max(10_000_000).optional(),
  maxPagesPerFirm: z.number().int().min(1).max(8).optional(),
  maxPageBytes: z.number().int().min(1024).max(1_000_000).optional(),
  modelName: z.enum(RESEARCH_MODELS).optional(),
});

export const researchSettingsSchema = z.object({
  enabled: z.boolean(),
  dailyFirmCeiling: z.number().int().min(0),
  dailyCostCeilingCents: z.number().int().min(0),
  monthlyCostCeilingCents: z.number().int().min(0),
  maxPagesPerFirm: z.number().int().min(1),
  maxPageBytes: z.number().int().min(1024),
  modelName: z.string().min(1).max(64),
  updatedByUserId: uuid.nullable(),
  updatedAt: instant.nullable(),
});

export const researchSettingsResultSchema = z.object({
  settings: researchSettingsSchema,
  spend: researchSpendSchema,
  /** What one run may cost at these settings. The number the ceilings are compared with. */
  worstCaseRunCents: z.number().int().min(0),
});
