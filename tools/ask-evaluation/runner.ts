import { performance } from 'node:perf_hooks';
import { askResponseSchema, crmResolvedSourceSchema } from '@fss/contracts';
import type { FrozenCorpus, FrozenManifest, EvaluationReport } from './contracts.ts';
import { groupEvaluationWindows, evaluationTextGroupId } from './contracts.ts';
import { originalTextHash, validateDevelopment } from './corpus.ts';
import { baselineReport, type CaseMeasurement } from './report.ts';

export interface EvaluationPublicReads {
  read(actorFixtureId: string, path: '/ask/read' | '/crm/processing/source/read', body: unknown):
    Promise<{status: number; body: unknown}>;
}
export interface DevelopmentEvaluationInput {
  phase: 'development_baseline';
  manifest: FrozenManifest;
  development: FrozenCorpus;
  publicReads: EvaluationPublicReads;
}
export async function runEvaluation(input: DevelopmentEvaluationInput): Promise<EvaluationReport> {
  const {manifest,corpus,windows} = validateDevelopment(input);
  const results: CaseMeasurement[] = [];
  for (const item of corpus.cases) {
    const started = performance.now();
    const result: CaseMeasurement = {caseId:item.id,category:item.category,path:'lexical',
      recallAt10:null,precisionAt10:null,ndcgAt10:null,supportedClaims:0,unsupportedClaims:0,
      unjudgedClaims:0,claimEvaluationState:'no_claims',claimJudgments:[],validCitations:0,
      invalidCitations:0,abstained:false,durationMs:0,qualityScoringState:'failed',
      finalReadObservations:[],usage:{outcome:'observed',calls:0,inputTokens:0,outputTokens:0,
        reservedCents:'0',observedCents:'0'},failures:[]};
    const fail = (code: CaseMeasurement['failures'][number]['code'],stage: CaseMeasurement['failures'][number]['stage']) => {
      result.failures.push({code,stage});
    };
    const permitted: {id:string;ordinal:number;text:string}[] = [];
    const readWindow = async (window: typeof windows[number], final: boolean) => {
      const raw=await input.publicReads.read(item.actorFixtureId,'/crm/processing/source/read', {
        workspaceId:window.source.workspaceId,sourceId:window.source.sourceId,kind:window.source.kind,
        revision:window.source.revision,contentHash:window.source.contentHash,locator:window.source.locator,
      });
      const parsed=crmResolvedSourceSchema.safeParse(raw.body);
      const matched=raw.status===200&&parsed.success&&parsed.data.passage!==null&&
        originalTextHash(parsed.data.passage.text)===window.textSha256&&
        JSON.stringify(parsed.data.source)===JSON.stringify(window.source)&&
        parsed.data.passage.locator===window.source.locator;
      if(final)result.finalReadObservations.push({windowId:window.id,observedAt:new Date().toISOString(),
        state:matched?'available':'unavailable'});
      if(!matched){fail('source_unavailable',final?'final_read':'canonical_read');return null;}
      return parsed.data.passage!.text;
    };
    try {
      for(const window of windows){const text=await readWindow(window,false);if(text!==null)permitted.push({id:window.id,ordinal:window.ordinal,text});}
      if(result.failures.length===0){
        const response=await input.publicReads.read(item.actorFixtureId,'/ask/read',item.request);
        const parsed=askResponseSchema.safeParse(response.body);
        if(response.status!==200||!parsed.success||parsed.data.operation!=='passages')fail('invalid_adapter_output','baseline');
        else {
          const answer=parsed.data;
          if(answer.truncated||!answer.coverage.scanComplete||windows.length>manifest.envelope.maxScoredWindowsPerCorpus){
            result.qualityScoringState='censored_source_or_result_cap';fail('truncated_baseline','baseline');
          } else {
            const groups=groupEvaluationWindows(permitted);
            const ranked:string[]=[];
            for(const passage of answer.passages){
              const groupId=evaluationTextGroupId(passage.text);
              for(const source of passage.sources){
                const window=windows.find(row=>JSON.stringify(row.source)===JSON.stringify(source));
                if(window===undefined||originalTextHash(passage.text)!==window.textSha256){
                  result.invalidCitations++;fail('canonical_quote_mismatch','baseline');
                }else result.validCitations++;
              }
              if(!groups.some(group=>group.groupId===groupId))fail('canonical_quote_mismatch','baseline');
              else if(!ranked.includes(groupId))ranked.push(groupId);
            }
            for(const window of windows)await readWindow(window,true);
            if(result.failures.length===0){
              const grades=new Map(groups.map(group=>[group.groupId,Math.max(0,...item.relevance
                .filter(label=>group.windowIds.includes(label.windowId)).map(label=>label.grade))]));
              const relevant=[...grades.values()].filter(grade=>grade>0).length;
              const selected=ranked.slice(0,10);
              const hits=selected.filter(id=>(grades.get(id)??0)>0).length;
              result.recallAt10=relevant===0?null:hits/relevant;
              result.precisionAt10=selected.length===0?null:hits/selected.length;
              const dcg=(values:number[])=>values.reduce((sum,grade,index)=>sum+(2**grade-1)/Math.log2(index+2),0);
              const ideal=dcg([...grades.values()].sort((a,b)=>b-a).slice(0,10));
              result.ndcgAt10=ideal===0?null:dcg(selected.map(id=>grades.get(id)??0))/ideal;
              result.qualityScoringState='scored';
            }
          }
        }
      }
    }catch{fail('adapter_unavailable','baseline');}
    result.durationMs=performance.now()-started;
    results.push(result);
  }
  return baselineReport(manifest,results);
}
