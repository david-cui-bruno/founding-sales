import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {candidateInputSchema,qualificationEvidenceSchema} from '@fss/contracts';
const caseSchema=qualificationEvidenceSchema.and(z.object({
 id:z.string(),candidate:candidateInputSchema,provenance:z.object({kind:z.string(),reviewNote:z.string()}).passthrough(),
 expectedEvidenceAccepted:z.boolean(),expectedAdmission:z.boolean(),expectedRank:z.enum(['fit_only','help_request','operational_burden','investigation']),
}));
const corpus=z.object({asOf:z.iso.datetime(),cases:z.array(caseSchema)}).parse(JSON.parse(readFileSync(new URL('./emailEvaluationSources.json',import.meta.url),'utf8')));
export const emailEvaluationAsOf=corpus.asOf;
const challenges=z.array(caseSchema).parse(JSON.parse(readFileSync(new URL('./emailEvaluationChallenges.json',import.meta.url),'utf8')));
export const emailEvaluationCases=[...corpus.cases,...challenges];
