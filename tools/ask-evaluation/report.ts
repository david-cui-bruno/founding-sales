import { reportSchema, type EvaluationReport, type FrozenManifest } from './contracts.ts';
import { evaluationHash } from './corpus.ts';
export type CaseMeasurement = EvaluationReport['caseResults'][number];

/** Aggregate measured fields; failures stay visible and never become empty successes. */
export function baselineReport(manifest: FrozenManifest, results: CaseMeasurement[]): EvaluationReport {
  const categories = [...new Set(results.map(row => row.category))];
  const percentile = (values: number[], fraction: number) => {
    const sorted = [...values].sort((a,b)=>a-b);
    return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)] ?? null;
  };
  return reportSchema.parse({
    manifestSha256:evaluationHash(manifest), baselineMeasured:results.length>0,
    realVectorMeasured:false,realModelMeasured:false,
    syntheticOrchestrationPassed:results.length>0&&results.every(row=>row.failures.length===0&&row.qualityScoringState==='scored'),
    modelEvaluationState:'not_run',caseResults:results,
    categorySummaries:categories.map(category=>{
      const cases=results.filter(row=>row.category===category);
      return {category,caseCount:cases.length,failures:cases.reduce((sum,row)=>sum+row.failures.length,0),
        p50Ms:percentile(cases.map(row=>row.durationMs),0.5),p95Ms:percentile(cases.map(row=>row.durationMs),0.95)};
    }),realQualityState:'pending_verified_purpose_budget_and_preregistration',activationAllowed:false,
  });
}
